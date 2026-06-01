# Production Audit — WhatsApp Multi-Agent Shared Inbox

**Date:** 2026-06-01  ·  **Branch:** main @ 6db3358  ·  **Method:** 16 parallel deep-dive auditors → adversarial verification of every finding against current code + locked decisions → scored synthesis (33 agents, 4.56M tokens, 1027 tool calls).

Findings below are **only those confirmed by an independent verifier re-reading the actual code.** False positives, already-handled concerns, and documented locked decisions were stripped (see Appendix B).

## Verdict

**Would I confidently deploy this to production today?  → YES WITH CAVEATS**

> Yes, with caveats — I would deploy this to production for the pilot today, but I would fix two things first and accept the rest as known, bounded risks. This is genuinely production-grade work for a solo-dev pilot: the highest-priority dimensions (chat send/receive, conversation loading, realtime, database, auth) are all carefully engineered, adversarial verification confirmed NO Critical issues, no cross-tenant leaks, no IDOR, no data-loss vectors, and no missing authz. The two things holding back an unqualified 'yes' are: (1) the OutboundSendAttempt retry-guard contradicts its own documented intent and turns every transient Meta 5xx/rate-limit into a permanent failed bubble requiring manual re-send — this silently nullifies the load-bearing 3-attempt retry policy on the core send path and degrades the optimistic-send UX to 'flaky' under exactly the conditions the queue was built to absorb; and (2) deployment safety — the api migrates forward as the first step of container boot, but auto-rollback only swaps code images with zero DB awareness and there is no pre-migration backup (freshest restore point can be ~24h stale), so a migration that applies-then-crashes can leave old code running against a moved-forward schema. Neither blocks the happy path, but #1 affects every agent's daily send experience and #2 turns the safety net into a potential outage amplifier. The active-call browser teardown gap (mic stays hot on SPA nav mid-call) is High and worth fixing in the same pass, though it's narrower in blast radius. Everything else is correctly-scoped low-severity scale-cliffs, documented deferrals, or maintainability debt that does not bite at one-customer pilot scale.

## Scores

| Dimension | Score | Justification |
|---|---|---|
| **Production Readiness** | **88/100** | Happy path is solid and the deploy pipeline is mature (smoke-tested health, retag rollback, graceful drain); the one real gap is incident-recovery — auto-rollback can revert code against a forward-applied migration with no pre-migration backup. |
| **Architecture** | **90/100** | Zero circular deps, mechanically-enforced events->sockets boundary, exemplary provider abstraction; only real debt is a missing canonical Contact serializer that has already drifted across ~7 publishers. |
| **Performance** | **91/100** | Hand-tuned memoization, keyset pagination, denormalized counters, RAF-coalesced ticks, room-scoped fanout; remaining items are documented scale-cliffs (unindexed mediaCaption OR-branch, 3x search fan-out) invisible at pilot scale. |
| **Realtime** | **92/100** | Among the most disciplined realtime layers reviewed — compiler-enforced fanout completeness, transition-gated presence, reconnect convergence; one narrow first-open status/media recovery gap, all cosmetic and self-healing. |
| **Database** | **93/100** | Production-grade 40-model schema with deliberate denormalization, comprehensive index coverage, correct Serializable retries + outbox + per-team-fair drainer; findings are pure scale-notes plus one stale comment. |
| **Reliability** | **87/100** | Outbox durability, crash-recovery journaling, graceful shutdown, dual unhandled-rejection net on api; two daily sweepers bypass the shared pool mutex (latent until ~100k messages) and the OutboundSendAttempt retry-guard defeats BullMQ retry on transient Meta errors. |
| **Security** | **88/100** | HMAC webhook verify, full SSRF guard, timing-safe internal RPC, rigorous teamId scoping with no IDOR found, Zod everywhere; minor login timing oracle and CSRF resting solely on SameSite=Lax (adequate for single-origin pilot). |
| **Maintainability** | **84/100** | Clean, cohesive, near-zero dead code; the recurring theme is duplication that has already started to diverge (4x normalizeCustomFields, 6x outbound-commit idiom, ~12 hand-rolled Contact DTOs) plus two misfiled inbox hooks under team-chat. |

**Confirmed findings:** 0 Critical · 2 High · 13 Medium · 46 Low  (total 61)

## Executive summary

This is an exceptionally well-engineered codebase for a solo-dev pilot-stage SaaS — among the most disciplined I have reviewed at this stage. Across 16 adversarially-verified dimensions there are ZERO Critical findings, no cross-tenant leaks, no IDOR, no mass-assignment, no missing authz, and no data-loss vectors. The hardest correctness problems are genuinely solved and verified in current code: inbound dedupe (Serializable retry + compound-unique gate), the transactional outbox for durable message.received/sent, optimistic-bubble reconciliation, the single-source-of-truth thread-reducer table with a dev-time coverage invariant, compiler-enforced realtime fanout completeness, rigorous teamId scoping on every by-id path, a complete SSRF guard, layered workflow loop/storm defenses, and a mature deploy pipeline with smoke-tested health and registry-backed rollback. The realtime, database, performance, and chat dimensions are production-grade at pilot scale, and the historical bug classes the project kept fighting (stuck unread, auth redirect loops, split-paint, OOM-137) are closed.\n\nThe honest weaknesses are concentrated and mostly bounded. Two are High and worth fixing before deploy: the OutboundSendAttempt retry-guard silently defeats BullMQ retry on transient Meta errors (turning routine 5xx/rate-limits into permanent failed bubbles on the core send path), and the deployment auto-rollback can revert code against a forward-applied migration with no pre-migration backup (a safety net that can amplify an outage). A third High — the active call is never torn down on SPA navigation mid-call, leaking a hot mic and stranding an in_progress row — is narrower but should land in the same pass. Beyond those, the recurring maintainability theme is duplication that has already begun to diverge: a missing canonical Contact serializer hand-rolled across ~7-12 sites (already dropping callPermissionRevokedUntil), four byte-for-byte normalizeCustomFields copies despite a helper built to kill exactly that, and the outbound commit/monotonicity idiom copy-pasted across six send paths with one variant already drifted. Team-chat surfaces lack the inbox's reconnect-convergence (Medium, internal-only, bounded). Everything else is correctly-scoped low-severity scale-cliffs or documented deferrals with clear triggers that do not bite at one-customer scale.

### Cross-cutting themes

- Correctness-critical hot paths are genuinely well-engineered and verified: dedupe, outbox durability, optimistic reconciliation, reconnect convergence, CAS-gated mutations, and tenant scoping all hold up under adversarial review with zero Criticals and no data-loss or cross-tenant findings.
- The dominant real risk is DUPLICATION THAT HAS ALREADY DRIFTED, not missing logic: a missing canonical Contact serializer (~7-12 hand-rolled copies dropping callPermissionRevokedUntil), 4x normalizeCustomFields, 6x outbound-commit idiom (one variant diverged). These are latent today but are the highest-consequence maintenance debt because the divergence is already started.
- Reliability/recovery is the weakest axis relative to the otherwise-high bar: the OutboundSendAttempt retry-guard contradicts its own docs and defeats retry; deploy auto-rollback is DB-unaware with no pre-migration backup; two daily sweepers bypass the shared pool mutex. The happy paths are strong; the failure/recovery paths have the real gaps.
- Browser-side call lifecycle is the soft spot of an otherwise-careful media/calling subsystem: no unmount teardown (hot mic on SPA nav) and no client-side ring timeout, in contrast to the meticulously CAS-gated server side.
- Asymmetry between inbox and team-chat surfaces: the inbox has documented, load-bearing reconnect-convergence and optimistic-dispatch discipline; team-chat (channel feed, sidebar, thread panel) has no reconnect recovery — the same bug class the inbox already learned to fix, left unfixed on the internal-collaboration surface.
- Mature operational judgment for pilot stage: heap sized under mem_limit, graceful drain tuned to BullMQ lockDuration, autovacuum tuning, per-team fairness gates, and a long list of explicitly-documented deferrals with clear triggers — the project consistently distinguishes 'fix now' from 'fix when seen', and the biggest stated risk (over-tinkering with already-correct code) is real.
- Documentation/config drift is the low-grade noise across dimensions: dead WEB_INTERNAL_URL env, stale cache-revalidate comments for a removed bridge, a schema comment claiming a sweeper is unwired when it exists, an inaccurate proxy cookie-signature claim, and two leftover 4096 heap flags — none break runtime but they actively mislead future debugging and audits.

## Blocking issues (fix before an unqualified yes)

### 🟠 [High] OutboundSendAttempt guard defeats BullMQ retry on transient Meta errors

**Why blocking:** Every browser text send carries a clientTempId -> jobId -> attempt row. On a transient Meta failure (503, rate_limit 4/80007, network blip) the catch stamps failedAt, BullMQ schedules attempt 2 with the same jobId, the P2002 handler hits branch (b) which only checks completedAt (never failedAt), and throws send_in_progress_or_lost as a non-recoverable 409 -> BullMQ stops retrying. The result is a permanent red failed bubble requiring manual agent re-send, directly contradicting two in-repo comments (schema.prisma:985-989, messages.service.ts:817-819) that say a retry should see failedAt and proceed. Transient Meta errors are routine at pilot scale, so this degrades the core send path's reliability for everyone, daily.

**Fix:** In the P2002 branch, when prior.failedAt is set and completedAt is null AND the prior failure was a definite Meta ERROR (not a silent mid-fetch timeout), reset/delete the attempt row and fall through to the normal send path so the retry actually re-sends — matching the documented intent. Keep the strict refuse-to-retry only for the genuinely ambiguous no-failedAt-no-completedAt case (death mid-Meta-fetch). Fix the live onMessageNew reconcile (chat-send-receive-2) in the same pass: match m.clientTempId === tempId && (m.pending || m.failed) so a failed->succeeded sequence consumes the failed twin instead of rendering a duplicate bubble with a double-send Retry button.

### 🟠 [High] Auto-rollback reverts code against a forward-applied migration with no pre-migration backup

**Why blocking:** docker-compose runs prisma migrate deploy as the FIRST step of the api container CMD, so the schema migrates forward during ship, before the health gate runs. The auto-rollback step only retags :previous images and recreates containers with zero DB awareness — no migrate resolve --rolled-back, no down migration. A migration that applies cleanly but then crashes the new app (or fails the / probe) triggers a rollback that installs OLD code against a NEW schema, which can 500 on every Prisma query. The only restore point is the nightly 03:17 pg_dump, up to ~24h stale. With 8 migrations shipped in ~1 week, schema changes are frequent and the box has one customer, so the blast radius is total outage plus a possibly-day-old restore.

**Fix:** Add a pre-migration pg_dump to the ship step before the api container recreates (the script already exists at /opt/ccp/pg-backup.sh — invoke it once tagged pre-deploy-<sha>.sql.gz) so the recovery point is seconds, not 24h, before the migration. For migrations that drop/rename columns, follow expand-contract (additive deploy first, destructive change a deploy later) so :previous code stays schema-compatible and auto-rollback is actually safe. At minimum, document in the rollback runbook that auto-rollback after a migration requires a manual restore decision.

---

## Findings by dimension

## Architecture & Boundaries

_This is an unusually well-architected pilot-stage codebase. The strongest signals: ZERO circular dependencies anywhere (verified with madge across apps/api 246 files, apps/web 289 files, packages/shared 26 files — only one bounded DI forwardRef between MessagesService↔SendWorkerService); a genuinely clean layering where framework-agnostic business logic in apps/api/src/lib/ is shared by multiple entry points (HTTP services, external /v1 API, workflow steps) and NEVER imports a Nest service (no dependency inversion); the MessagingProvider abstraction is exemplary (channel-keyed registry, paired config loader, typed capability narrowing, documented Meta-only escape hatch); the events→sockets boundary is mechanically enforced (only RealtimeFanoutService crosses from the bus to a socket.emit, and FANOUT_RULES is a mapped type over the full DomainEventType union so a missing fanout rule fails typecheck); the setSharedDb Proxy db wiring is well-reasoned and documented; Better Auth config is shared via packages/shared so api/web stay in lockstep; the bus's two-tier priority dispatch is thoughtfully ordered. The real issues are concentrated and mostly cosmetic/maintainability: the one with an actual correctness consequence is a missing shared Contact serializer (mapContact exists but workflow steps hand-roll a divergent Contact projection that omits callPermissionRevokedUntil, and that payload is broadcast over sockets). The rest are misplaced ownership (an inbox hook filed under team-chat; the Redis connection factory nested under lib/workflows/) and documentation/config drift around the cross-process internal bridge (a dead WEB_INTERNAL_URL env, stale "cache-revalidate" comments for what is now a session-invalidation bridge). The system is easy to reason about and ownership is, with a few exceptions, predictable._

### 🟡 [Medium] architecture-1 — Workflow steps hand-roll a divergent Contact payload instead of the canonical mapContact serializer — socket frames lose callPermissionRevokedUntil

**Location:** apps/api/src/lib/queries/_shared.ts:121-145 (canonical) vs apps/api/src/lib/workflows/steps/update-field.ts:129-148 + tag.ts (~119-130) + update-lifecycle.ts (~108-117) + ask-question.ts (~508-521); fanout at apps/api/src/realtime/fanout-rules.ts:187-196

**Problem.** A canonical Prisma-row→Contact serializer exists at apps/api/src/lib/queries/_shared.ts:121 (mapContact), used only by the query layer (2 files). The workflow steps update-field.ts, tag.ts, update-lifecycle.ts, ask-question.ts, plus broadcasts.service.ts and lib/workflows/dispatcher.ts each hand-roll the SAME Contact projection inline. The inline copies have ALREADY drifted: mapContact includes `callPermissionRevokedUntil` (lib/queries/_shared.ts:135 — the field that gates the inbox Phone button so a revoked contact doesn't show an enabled call button) and omits `tagIds`; the workflow-step projection (e.g. apps/api/src/lib/workflows/steps/update-field.ts:129-148) OMITS `callPermissionRevokedUntil` and ADDS `tagIds`. update-field.ts:156 then `publish({ type: 'contact.updated', contact: payload, ... })`, and the fanout rule at apps/api/src/realtime/fanout-rules.ts:187-196 emits that exact payload verbatim to the team room as `contact:updated`. So a workflow-driven contact mutation broadcasts a Contact shape different from every read path's shape.

**Why dangerous.** A client cache reducer that patches its contact snapshot from a workflow-emitted `contact:updated` frame loses `callPermissionRevokedUntil`, which can resurrect an enabled Phone button for a contact whose calling permission was revoked — the exact UX the field was added to prevent (see the comment at _shared.ts:133). More broadly, every future field added to mapContact must be manually re-added to ~6 hand-rolled copies or it silently disappears from workflow/broadcast socket payloads. This is the classic missing-abstraction drift bug, and it is already live, not hypothetical.

**Impact.** At pilot scale: a contact whose call permission was revoked, then touched by any workflow (set field / add tag / change stage), pushes a socket frame that can flip the inbox Phone button back to enabled for every connected agent until a fresh read corrects it; an agent who clicks it gets a backend rejection. As workflows and field counts grow, every Contact-shape change risks silently omitting fields from automation-driven realtime updates.

**Fix.** Export mapContact (and a matching tagIds-inclusive variant if the workflow frames genuinely need tagIds — they appear to, for the optimistic UI) as the single Contact serializer and call it from every site that builds a Contact payload (the 4 workflow steps, broadcasts.service.ts, dispatcher.ts). Add a unit-level type assertion or a single `toContactWire(row)` so the wire shape has exactly one source. This also collapses the duplicated normalizeCustomFields (_shared.ts:206) / normalizeStringMap (lib/normalize-string-map.ts) pair, which are byte-for-byte identical despite the latter's comment claiming it already consolidated all copies.

**Verifier evidence.** apps/api/src/lib/queries/_shared.ts:135-136 (canonical includes field) vs apps/api/src/lib/workflows/steps/update-field.ts:129-148 + tag.ts:111-130 + update-lifecycle.ts:98-115 + ask-question.ts:504-538 + contacts.service.ts:418-459 (everyday HTTP path) + lib/providers/ingest.ts:1156 toDomainContact, all omit it; fanout apps/api/src/realtime/fanout-rules.ts:192-197; reducer apps/web/src/features/inbox/lib/thread-reducers.ts:85-88; gate apps/web/src/features/inbox/components/inbox-shell.tsx:94-98,1004-1010; only client reader is inbox-shell.tsx:1009

### 🟡 [Medium] architecture-6 — Every contact.updated/created socket publisher (not just workflow steps) hand-rolls the Contact wire shape — the everyday agent-edit HTTP path drops callPermissionRevokedUntil too

**Location:** apps/api/src/contacts/contacts.service.ts:418-459 (standard agent PATCH) + :194,:277,:637,:1368; apps/api/src/lib/providers/ingest.ts:1156 (toDomainContact); apps/api/src/lib/queries/_shared.ts:121-145 (the canonical mapContact that already has the field) vs :206 (duplicate normalizeCustomFields)

**Problem.** This is the broader form of architecture-1's drift, found by enumerating ALL publishers of contact.updated/contact.created (grep: 7 files). Beyond the 4 workflow steps the auditor cited, the STANDARD user-facing paths also hand-roll the same projection and omit callPermissionRevokedUntil: contacts.service.ts:418-459 (the normal HTTP PATCH update an agent triggers from the contact panel) and contacts.service.ts:194/277/637/1368 (create / bulk-tag / tag-set paths), plus lib/providers/ingest.ts:1156 toDomainContact (fires on EVERY inbound message that touches a contact) and external/v1. None call mapContact; each independently lists ~16 fields and forgets the one calling-state field. So the resurrected-Phone-button window is not a rare workflow-only event — it is opened by the most common contact mutation of all (an agent editing a contact's name/email), and by every inbound message from a revoked contact.

**Why dangerous.** It widens architecture-1 from 'workflow-driven' to 'essentially any contact mutation'. With one canonical serializer (mapContact already exists and is correct) this whole class evaporates; without it, the field was clearly added to mapContact (with a load-bearing comment at _shared.ts:133) but never propagated to the 7 inline copies, so the gate it powers is defeated by the dominant code paths. It also means the next field added to the Contact wire type will silently vanish from every realtime contact frame again.

**Impact.** At pilot scale: an agent edits any field on a contact whose call permission was revoked → contact.updated fans to the team room → applyContactUpdate replaces the cached contact (callPermissionRevokedUntil now undefined) → the Phone button re-enables for every connected agent until a fresh full read. An inbound message from that contact does the same via toDomainContact. Self-heals on next /api/inbox/conversation/:id fetch, but the stale-enabled button yields a backend permission_revoked rejection if clicked in the meantime.

**Fix.** Export mapContact as the single Prisma-row→Contact wire serializer and call it from all 7 publishers (the 4 workflow steps + contacts.service.ts's 6 inline payloads + ingest.ts toDomainContact + external-v1). If tagIds is genuinely needed on the wire frames (it is, for optimistic list/panel reconciliation), add it to mapContact (it's currently omitted there) or expose a thin toContactWire(row, {tagIds}) wrapper so there is exactly one source of the shape. Also collapse the duplicate normalizeCustomFields (_shared.ts:206) into the canonical normalizeStringMap (lib/normalize-string-map.ts) whose own header comment already claims it consolidated all copies.


### ⚪ [Low] architecture-2 — useTeamEvents (the inbox conversation-list realtime hook) is misfiled under features/team-chat, creating inverted ownership and a feature-level import loop

**Location:** apps/web/src/features/team-chat/hooks/use-team-events.ts (imports inbox at lines 7,9; consumed only by inbox)

**Problem.** apps/web/src/features/team-chat/hooks/use-team-events.ts is, by its contents, the inbox conversation-LIST socket hook: it owns `ConversationWithRefs[]`, inbox filters (imports `Filter` from @/features/inbox/components/inbox-controls), and imports `onOptimisticListBump` from @/features/inbox/lib/optimistic-list-bump. Its only consumers are inbox files (inbox-shell.tsx:23, connection-banner.tsx, use-conversation-counts.ts) — NO team-chat component uses it. 'Team' here means 'team-wide conversation list', a naming collision with the team-chat FEATURE. So a core inbox concern lives in the wrong feature, and team-chat imports inbox internals while inbox imports the team-chat hook (a bidirectional feature dependency; madge sees no file cycle only because the specific files don't close one).

**Why dangerous.** Ownership is unpredictable: a developer touching the conversation-list realtime path would not look in features/team-chat, and someone refactoring team-chat could break the inbox. The bidirectional feature coupling is exactly the seam that turns into a hard-to-untangle cycle as either feature grows.

**Impact.** No runtime impact today. Pure maintainability/onboarding cost — it makes the single most-touched realtime surface (inbox list) harder to find and reason about, and quietly couples two features that should be independent.

**Fix.** Move use-team-events.ts to features/inbox/hooks/ and rename to something like use-conversation-list-events.ts (keep a re-export shim if any import path is load-bearing). This removes the team-chat→inbox import and puts the hook with its only consumers. Web features generally lack public barrels so cross-feature imports reach deep internals — adopting a per-feature index.ts public surface would prevent this class of misfiling, but that is a larger optional cleanup.

**Verifier evidence.** apps/web/src/features/team-chat/hooks/use-team-events.ts:7 (imports inbox optimistic-list-bump), :9 (imports inbox Filter); consumers all in apps/web/src/features/inbox/; grep of features/team-chat for useTeamEvents matches only the file itself

### ⚪ [Low] architecture-3 — Shared Redis/BullMQ connection infrastructure is nested under the workflows domain, with redisUrl() duplicated across queue modules

**Location:** apps/api/src/lib/workflows/queue.ts:33,46,63,78 (shared factory); apps/api/src/lib/outbound-webhooks/queue.ts:33 (duplicate redisUrl); consumers: apps/api/src/messages/send-queue.ts:3, apps/api/src/lib/broadcasts/schedule-queue.ts:12-15

**Problem.** apps/api/src/lib/workflows/queue.ts is the de-facto shared Redis infrastructure module — it owns getRedisConnection(), createWorkerConnection(), connectionOptions(), and redisUrl(). Three unrelated domains reach into this workflows-named path for their connection: messages/send-queue.ts:3 + send-worker.service.ts:14, and lib/broadcasts/schedule-queue.ts:12-15. Separately, lib/outbound-webhooks/queue.ts re-declares its own redisUrl() (queue.ts:33, byte-identical to workflows/queue.ts:33) and its own getWebhookRedisConnection() rather than sharing the factory. So 'where does the Redis connection config live?' has the misleading answer 'under workflows', and the connection-tuning boilerplate (maxRetriesPerRequest:null, connectTimeout, commandTimeout) is partially copy-pasted.

**Why dangerous.** Misplaced ownership: a Redis tuning change (e.g. commandTimeout) made in workflows/queue.ts does not propagate to the outbound-webhook connection, so the two can drift. New queue authors must know to import connection plumbing from a domain module unrelated to their feature.

**Impact.** None at runtime today (all queues work). Drift risk only: a future connection-resilience fix applied in one place silently skips the duplicated copy.

**Fix.** Extract the connection factory + redisUrl() into a domain-neutral lib/redis/connection.ts (getRedisConnection, createWorkerConnection, connectionOptions). Have workflows/queue.ts, messages/send-queue.ts, broadcasts/schedule-queue.ts AND outbound-webhooks/queue.ts import from it. Per-queue separate connections can remain (BullMQ best practice); only the URL + tuning belong in one place.

**Verifier evidence.** apps/api/src/lib/workflows/queue.ts:33-65 (factory); apps/api/src/lib/outbound-webhooks/queue.ts:33-42 (duplicate redisUrl), :46-53 (duplicate tuning), :67 (comment pointing back to workflows); consumers apps/api/src/messages/send-queue.ts:3, send-worker.service.ts:14, lib/broadcasts/schedule-queue.ts:11-15

### ⚪ [Low] architecture-4 — Cross-process internal-bridge config is stale/dead: WEB_INTERNAL_URL is unused, and compose + validateEnv describe a removed 'cache-revalidate' bridge instead of the live session-invalidation one

**Location:** docker-compose.yml:217-221,354-360; packages/config/src/index.ts:75-82; apps/api/src/team/tags/tags.service.ts:22-24; apps/web/src/lib/auth/session-invalidation.ts:34

**Problem.** The api→web cache-revalidate bridge (/api/internal/revalidate) was removed (confirmed by apps/api/src/lib/events/bus.ts:75-77, apps/web/src/lib/api-client.ts:125-128, apps/web/src/lib/api/queries.ts:121). But the config still documents it as live in multiple places: docker-compose.yml:217-221 (app) and :354-360 (api) describe INTERNAL_BUS_SECRET as 'for the cross-process cache-revalidate bridge — NestJS POSTs to /api/internal/revalidate', and define WEB_INTERNAL_URL (:360) as 'Where this process posts cache-revalidate calls to the Next.js process'. WEB_INTERNAL_URL is read NOWHERE in the codebase — it is a dead env var. INTERNAL_BUS_SECRET IS live but for a DIFFERENT bridge: web→api session-invalidation (apps/web/src/lib/auth/session-invalidation.ts:26-34 POSTs to INTERNAL_API_URL + /api/internal/session-invalidated; handler at apps/api/src/auth/internal-session.controller.ts). Even the validateEnv hint (packages/config/src/index.ts:75-82) states the direction backwards ('NestJS → Next.js') vs the actual web→api flow. CLAUDE.md likewise still references the /api/internal/revalidate bridge as current.

**Why dangerous.** Config that lies about what it does is a latent operational hazard: an operator could 'fix' a non-problem by configuring WEB_INTERNAL_URL, or could mis-debug a session-invalidation failure by looking for a cache-revalidate endpoint that no longer exists. A future dev could re-introduce the removed revalidate bridge believing it's still wired. The inverted direction in validateEnv compounds the confusion.

**Impact.** No runtime breakage — INTERNAL_BUS_SECRET is required and present, the session-invalidation bridge works, and the dead WEB_INTERNAL_URL is harmless because nothing reads it. Pure correctness-of-documentation/operability cost.

**Fix.** Delete WEB_INTERNAL_URL from docker-compose.yml (api env). Rewrite the INTERNAL_BUS_SECRET comments in compose (lines 217-221, 354-356) to describe the web→api session-invalidation bridge. Fix the direction in packages/config/src/index.ts:78 ('Next.js → NestJS'). Update the CLAUDE.md reference to /api/internal/revalidate (it was removed). Also fix the stale comments still claiming a Next.js cache-revalidate subscriber + unstable_cache in apps/api/src/team/tags/tags.service.ts:22-24 and apps/api/src/lib/events/bus.ts:75-77.

**Verifier evidence.** no /api/internal/revalidate route (find returns empty); apps/api/src/lib/events/bus.ts:75-77 (tier removed but comment still cites the removed bridge); docker-compose.yml:217-221,354-360 (stale comments + dead WEB_INTERNAL_URL:360); packages/config/src/index.ts:78 (direction backwards); apps/web/src/lib/auth/session-invalidation.ts:27,34 + apps/api/src/auth/internal-session.controller.ts:53 (real web→api flow); apps/api/src/team/tags/tags.service.ts:22-24 (stale revalidate comment)

### ⚪ [Low] architecture-5 — WorkflowSubscribersService bootstraps four unrelated bus concerns (realtime, audit, analytics, workflow-dispatch) from inside the workflows module

**Location:** apps/api/src/workflows/workflow-subscribers.service.ts:40-52; module declaration apps/api/src/workflows/workflows.module.ts:21

**Problem.** apps/api/src/workflows/workflow-subscribers.service.ts (in the workflows module) registers FOUR logically distinct subscriber families on onModuleInit: realtime fanout, audit, analytics, and workflow-dispatch (lines 46-49). Three of them (realtime, audit, analytics) have nothing to do with workflows. It can inject RealtimeFanoutService only because RealtimeModule is @Global. So the single registration site for cross-cutting domain side effects is owned by, and named after, one specific domain. The class name and module location both misrepresent its responsibility.

**Why dangerous.** Reduced cohesion / surprising ownership: a developer disabling or debugging the analytics or audit subscriber would not expect to find its registration in the workflows module. It also means the workflows module has a hidden dependency on realtime via the global module rather than an explicit import, which weakens the module-boundary story the rest of the codebase upholds well.

**Impact.** No runtime impact (registration is idempotent and order is priority-encoded, not registration-order dependent). Onboarding/maintainability cost only; the misnomer makes the bus wiring harder to locate.

**Fix.** Rename to BusSubscribersService (or SubscriberRegistrationService) and relocate it under events/ (next to EventBusModule), or split per-concern (audit/analytics register from their own module, as outbound-webhooks already does). The outbound-webhooks subscriber already follows the better pattern (registers from its own module at its own priority tier) — make the rest symmetric.

**Verifier evidence.** apps/api/src/workflows/workflow-subscribers.service.ts:40 (injects RealtimeFanoutService), :46-49 (registers realtime/audit/analytics/dispatch); apps/api/src/workflows/workflows.module.ts:21 (declared here); apps/api/src/realtime/realtime.module.ts:34 (@Global); contrast apps/api/src/outbound-webhooks/outbound-webhooks.subscriber.ts + outbound-webhooks.module.ts (own-module pattern)

---

## Chat — Send / Receive / Dedup / Optimistic (HIGHEST PRIORITY)

_This pipeline is genuinely well-engineered and shows deep, hard-won care: the inbound dedupe is correct (Serializable tx for the contact/conversation race + compound-unique `teamId_channel_externalId` P2002 gate), the outbox pattern makes message.received/message.sent durable across crashes, the optimistic-bubble lifecycle (clientTempId reconcile + 30s watchdog + ccp:optimistic-confirmed cancel) is solid, timestamp-monotonicity guards are applied consistently on every send path, the OutboundSendAttempt double-send guard is thoughtfully designed, parked-status replay handles the status-before-row race, and the recovery-refetch reconcileOptimisticAgainst correctly dedupes own-sends whose confirming frame was swallowed. The strongest concern is a real divergence between the OutboundSendAttempt retry-guard CODE and its own documented intent: a transient Meta error (5xx / rate-limit) defeats the BullMQ 3-attempt retry policy because the second attempt refuses any prior row lacking completedAt — even a clean failedAt-only row. A secondary, narrower gap: the live onMessageNew reconcile only swaps PENDING optimistic rows, not FAILED ones, so a failed→succeeded sequence (send_failed then message:new) can render the message twice with a stale Retry button. Both are reliability issues on the core send path, not data loss or cross-tenant leaks._

### 🟠 [High] chat-send-receive-1 — OutboundSendAttempt guard defeats BullMQ retry on transient Meta errors (code contradicts its own schema/comment intent)

**Location:** apps/api/src/messages/messages.service.ts:701-804 (esp. 713-800); contradicting comments at messages.service.ts:817-819 and prisma/schema.prisma:985-989; retry policy at apps/api/src/messages/send-queue.ts:94 and categorization at apps/api/src/messages/send-worker.service.ts:258-261,274-275

**Problem.** In executeTextSendJob, the first attempt inserts an OutboundSendAttempt row (messages.service.ts:704-707, attemptCreated=true). If binding.provider.sendText then throws a TRANSIENT error (Meta 503, rate_limit, network blip), the catch stamps the row with failedAt (no completedAt) and re-throws (messages.service.ts:816-848). categorizeSendError classifies a 5xx/rate_limited/network failure as recoverable=true (send-worker.service.ts:258-261, 274-275), so BullMQ schedules attempt 2 with the SAME jobId. On attempt 2, outboundSendAttempt.create P2002s (row exists). The recovery branch only checks `prior?.completedAt && prior.externalId` for the success-replay path (messages.service.ts:717); a row with failedAt set but completedAt null falls straight through to branch (b) and throws send_in_progress_or_lost as a NON-recoverable error (messages.service.ts:795-800), so BullMQ stops retrying. The schema comment (schema.prisma:985-989) and the catch comment (messages.service.ts:817-819) BOTH explicitly state a retry should 'see failedAt set and proceed normally' — but the code never checks failedAt and never allows a failed-only prior to proceed.

**Why dangerous.** It silently nullifies the documented, load-bearing 3-attempt retry policy (send-queue.ts:94, attempts:3 with exponential backoff) for every browser-originated text send (all of which carry a clientTempId → a jobId → an attempt row). The first transient Meta hiccup becomes a permanent red 'failed' bubble that an agent must manually re-send, instead of auto-recovering on retry. The behavior directly contradicts two in-repo comments describing the opposite intent, so it will read as 'already handled' to any reviewer.

**Impact.** At pilot scale Meta 503s, transient rate-limit (code 4/80007), and network blips are routine; each one now surfaces as a failed send requiring manual agent retry rather than transparent recovery. The optimistic-bubble UX degrades to 'flaky sends' under exactly the conditions the queue+retry machinery was built to absorb. Grows worse with volume (more sends = more transient hits).

**Fix.** In branch (b), distinguish a clean failure from an in-flight/lost one. When `prior.failedAt && !prior.completedAt`, a Meta ERROR response (vs a silent timeout) means Meta almost certainly did NOT accept the message, so it is safe to retry: delete/reset the attempt row (or update it back to a fresh attempt) and fall through to the normal send path, matching the schema+catch comments. Keep the strict refuse-to-retry ONLY for the genuinely ambiguous case (no failedAt and no completedAt = death mid-Meta-fetch). Optionally record on the attempt whether the failure was a definite Meta-reject vs a timeout, so timeouts stay conservative while definite rejects retry.

**Verifier evidence.** apps/api/src/messages/messages.service.ts:701-804 (P2002 handler: only branch at 717 checks completedAt; no failedAt check; throw at 795-800), catch stamps failedAt for all errors at 816-832; apps/api/src/messages/send-worker.service.ts:258-261,274-275 (categorizeSendError recoverable derivation, 409/non-5xx → false); apps/api/src/messages/send-queue.ts:94 (attempts:3); prisma/schema.prisma:985-989 (contradicting schema comment)

### ⚪ [Low] chat-send-receive-2 — Live onMessageNew reconcile ignores FAILED optimistic rows → duplicate bubble + stale Retry on failed-then-succeeded sequence

**Location:** apps/web/src/features/inbox/hooks/use-conversation-events.ts:928-998 (reconcile gate at 930) and the failed-marker at 1135-1144; worker ordering at apps/api/src/messages/send-worker.service.ts:38-41,205-225; replay re-publish at apps/api/src/messages/messages.service.ts:762-779

**Problem.** The live socket handler onMessageNew only reconciles optimistic rows that are still pending: `if (m.clientTempId !== tempId || !m.pending) return m;` (use-conversation-events.ts:930). The send worker publishes message.send_failed on EVERY attempt failure FIRST, then publishes message.sent if a later attempt succeeds (send-worker.service.ts:38-41,205-225) — the worker's own doc even claims 'if the retry succeeds, the swap-in via message:new overrides it'. But by the time message:new arrives, onMessageFailed (use-conversation-events.ts:1135-1144) has already flipped the bubble to pending=false, failed=true. The clientTempId reconcile then skips it (not pending), the externalId dedupe doesn't match (failed bubble still carries externalId=clientTempId, server carries the real wamid), and appendSorted appends the confirmed server copy alongside the failed one (use-conversation-events.ts:995-998). Result: the same message rendered twice — once as a 'failed' bubble with a Retry button (a double-send invitation) and once confirmed. The recovery-fetch path handles exactly this via reconcileOptimisticAgainst (use-conversation-events.ts:99-146), but the LIVE path has no equivalent failed→confirmed reconcile.

**Why dangerous.** A confirmed-delivered message is shown side-by-side with a phantom 'failed + Retry' bubble for the same content; clicking Retry double-sends to the customer on WhatsApp. It is the exact double-send trap the recovery-path reconcile was written to prevent, just on the live channel. Today it is largely masked by finding #1 (transient retries are refused, so failed-then-succeeded rarely occurs via the queue), but it is directly reachable through the branch-(a) success-replay path which re-publishes message.sent with the same clientTempId (messages.service.ts:762-779) after a prior failed publish, and would become common the moment finding #1 is fixed.

**Impact.** Bounded but real: an agent sees a duplicate message with a misleading Retry affordance; tapping it re-delivers to the customer. Low frequency today, but its frequency rises sharply if/when the retry path (finding #1) is repaired, so the two should be fixed together.

**Fix.** Make onMessageNew's clientTempId reconcile also consume a FAILED optimistic twin: match `m.clientTempId === tempId && (m.pending || m.failed)` and swap it for the server copy (clearing failed). Alternatively, when a message:new arrives that confirms a clientTempId, explicitly drop any failed row with that clientTempId before appending. This mirrors the failed-aware logic already present in reconcileOptimisticAgainst for the recovery path.

**Verifier evidence.** apps/web/src/features/inbox/hooks/use-conversation-events.ts:911 (externalId-only dedupe), 930 (pending-only reconcile gate), 996-998 (id-based append routing), 58-85 (appendSorted no content dedup), 131-145 (reconcileOptimisticAgainst also pending-only, line 132); apps/web/src/features/inbox/components/reply-box.tsx:609 (fresh clientTempId per submit), 644/672 (externalId=clientTempId); apps/web/src/features/inbox/components/message-thread.tsx:401-412 (retryFailed removes failed bubble first); branch-(a) crash-only path apps/api/src/messages/messages.service.ts:717-781
  _(verdict: partially_confirmed)_

### ⚪ [Low] chat-send-receive-3 — markReadOnAgentSend + autoAssignOnAgentSend fire on enqueue, before the async text send is known to succeed

**Location:** apps/api/src/messages/messages.service.ts:440-461 (sendText: markRead/autoAssign at 447-448, enqueue at 449); contrast the worker send at messages.service.ts:937-962

**Problem.** For text sends, markReadOnAgentSend and autoAssignOnAgentSend are invoked synchronously right after preflightTextSend passes and BEFORE enqueueMessageSend (messages.service.ts:447-448), i.e. before the background worker has actually called Meta. The preflight only validates conversation existence, phone, 24h window, reply target, and provider config — the actual Meta send can still fail in the worker (5xx, invalid_recipient 131026/131051, provider_rejected). When it does, the thread has already been claimed for the sender, (re)opened from pending/closed to open, marked team-wide read, and emitted conversation.assigned + conversation.status_changed (driving audit pills, workflows, and outbound webhooks) — for a reply that never reached the customer.

**Why dangerous.** A send that ultimately fails still mutates ownership/status/read-state and fires audit + workflow + partner-webhook side effects as if the agent successfully engaged. An 'On Conversation opened/assigned' workflow or a partner integration can trigger off a reply that the customer never received. This diverges from the media/template paths' intent that engagement side effects follow an ACCEPTED send.

**Impact.** Minor and bounded at pilot scale: assigning/opening a thread you actively tried to reply to is mostly defensible UX, and team-wide read self-heals on the next inbound. The real cost is spurious audit pills and false workflow/outbound-webhook triggers on failed sends. Frequency tracks the transient-failure rate (amplified by finding #1).

**Fix.** Move markReadOnAgentSend/autoAssignOnAgentSend for the queued text path to fire on the worker's successful Meta send (alongside commitOutboundEvent in executeTextSendJob) rather than at enqueue time, matching the 'after the send is accepted' contract the sync paths already follow. If keeping them at enqueue for snappy UX is preferred, gate the workflow/outbound-webhook-visible side effects so a subsequent message.send_failed can roll back or suppress them.

**Verifier evidence.** apps/api/src/messages/messages.service.ts:447-449 (markRead/autoAssign before enqueue); 369-395 (autoAssignOnAgentSend publishes conversation.assigned + conversation.status_changed); contrast sync sibling paths at 996-1001 (media), 2096-2099 (template), 2173-2177 (interactive) with explicit 'only after the send is accepted' comments; preflight rejections at 518/527-531/546-551/560-566/575-580/595-604

---

## Chat — Conversation Loading / Switching / Pagination / Cache (HIGHEST PRIORITY)

_This is, frankly, one of the most carefully engineered client-state subsystems I have audited. The single-source-of-truth reducer table (thread-reducers.ts) with the dev-only `assertReducerCoverage` invariant genuinely closes the "missed cache-patch wiring" bug class CLAUDE.md keeps warning about; both consumers (use-conversation-events + inbox-shell) iterate the same array so they cannot drift. The markRead convergence story (mount POST regardless of stale snapshot, local conversation:read dispatch, three recovery paths, CAS on the server) is correct and matches the documented locked decisions. Optimistic-vs-recovery reconciliation (reconcileOptimisticAgainst by body + media-kind), the recency `>` guard against replayed frames, the snapshot-on-leave + tail-anchored gate, the SSR bottom-snap, and the keyset cursors are all sound and I could not break them. The real findings are bounded edge cases at the margins of the reconnect/pagination interaction, not correctness holes in the hot path. Notably the conversation-list cursor is NOT re-synced after a reconnect/visibility resync, which can leave a gap in "load older conversations" — the one finding I'd actually fix before scale. Nothing here is Critical or High at pilot scale._

### ⚪ [Low] chat-load-switch-2 — Orphaned 30s send-watchdog timer + window listener leak on chat-switch before send confirms

**Location:** apps/web/src/features/inbox/components/reply-box.tsx:838-850 (no unmount cleanup for watchdogId / onConfirmed listener)

**Problem.** ReplyBox's post-HTTP "stuck watchdog" (`window.setTimeout(... 30_000)` + `window.addEventListener('ccp:optimistic-confirmed:<tempId>', onConfirmed)`) is created inside the async send IIFE with no component-unmount cleanup (reply-box.tsx:838-850). When the agent sends and immediately switches chats, MessageThread (and thus ReplyBox + useConversationEvents) unmounts. The confirming `message:new` for that send arrives while the old thread's hook is gone, so the `ccp:optimistic-confirmed:<tempId>` window event is never dispatched (it's only fired by the mounted hook for the matching conversation, use-conversation-events.ts:921-927). The orphaned watchdog survives, fires after 30s, and calls `onOptimisticFail(tempId)` on the now-unmounted hook's setData (no-op + dev warning).

**Why dangerous.** The timer + the `addEventListener` are not garbage-collected until they fire (30s) because `window` holds the listener and the timer holds its closure (which captures the File for media sends). Rapid send-then-switch across many threads accumulates up to 30s worth of these. The user-visible failure self-heals: on switch-back the `?after=` backfill + reconcileOptimisticAgainst removes the pending bubble by body/media-kind match, so no phantom-failed bubble or double-send results.

**Impact.** Negligible at pilot scale — a short-lived per-send leak and a benign unmounted-setState warning in dev. Worst case for a media send is pinning one File's bytes in the closure for up to 30s after navigating away. No correctness or double-send risk because the recovery path reconciles it.

**Fix.** Tie the watchdog to the component lifecycle: store `watchdogId` + the listener in a ref-tracked set and clear/remove them in a ReplyBox unmount `useEffect` cleanup (the file already has the pattern for slashDebounceRef at :326-330). Or move the watchdog into useConversationEvents keyed by clientTempId so it shares the hook's unmount cleanup.

**Verifier evidence.** apps/web/src/features/inbox/components/reply-box.tsx:838-850 (watchdog created in IIFE, no unmount cleanup); contrast cleanup pattern at :326-332; apps/web/src/features/inbox/hooks/use-conversation-events.ts:921-927 (confirm event only fired by mounted matching hook); apps/web/src/features/inbox/components/message-thread.tsx:1164 (onOptimisticFail → markOptimisticFailed, a setData no-op after unmount)

### ⚪ [Low] chat-load-switch-3 — In-memory thread slice cap (500) bounds load-older but not live tail growth

**Location:** apps/web/src/features/inbox/hooks/use-conversation-events.ts:494 (cap applied in loadOlder only) vs :907-998 (onMessageNew appendSorted, uncapped)

**Problem.** `MAX_THREAD_SLICE = 500` (use-conversation-events.ts:494) only gates the load-older prepend path — when crossed, the older-cursor is dropped and `reachedSliceCap` shows the "use search" hint. The live `onMessageNew` append path (appendSorted) has no cap. The thread is deliberately not virtualized (locked decision), so a thread that reaches 500 via load-older and then receives a sustained burst of new inbound/outbound keeps growing the DOM bubble count past 500 unbounded for the life of that mount.

**Why dangerous.** Each bubble carries a LocalTime, framer-motion entrance, and media subcomponents; well past 500 live DOM nodes, scroll perf and the per-event ResizeObserver/snap work degrade. It's a slow-burn perf cliff on a single very-long-lived, very-busy thread, not a correctness issue.

**Impact.** Effectively unreachable at pilot scale — needs one agent parked on one thread that both scrolls deep AND receives hundreds of subsequent messages without a chat-switch (which would reset the slice to the latest page). No data loss. The chat-switch / refresh resets back to the bounded SSR window.

**Fix.** If ever observed, trim the head of the in-memory slice when live appends push it well past the cap (e.g. keep the most recent ~500, drop the oldest loaded page and restore the older-cursor so load-older still works). Acceptable to leave as-is until a real busy-thread perf report; the existing reset-on-switch already mitigates it in practice.

**Verifier evidence.** apps/web/src/features/inbox/hooks/use-conversation-events.ts:494 + :516-519 (cap applied in loadOlder only), :995-998 (onMessageNew appendSorted uncapped), :1371 (addOptimistic uncapped), :405-412 (chat-switch resets slice to SSR window); apps/web/src/features/inbox/components/message-thread.tsx:1007 (non-virtualized timeline.map)

### ⚪ [Low] chat-load-switch-4 — resyncOnce leaves hasMore ("Load older conversations") stale-true when the team shrinks below one page during the offline gap

**Location:** apps/web/src/features/team-chat/hooks/use-team-events.ts:356-429 (resyncOnce never calls setNextCursor) vs :975 (hasMore = nextCursor !== null) and the reset present at :243 / :314

**Problem.** resyncOnce (use-team-events.ts:356-429) fetches a fresh page 1 but discards the fresh page's nextCursor — it never calls setNextCursor. hasMore is derived as nextCursor !== null (use-team-events.ts:975). If, during the offline gap, conversations were deleted/closed-out such that the team now fits in a single page (fresh page nextCursor would be null), the stale pre-disconnect non-null cursor is retained, so hasMore stays true and the inbox keeps showing the 'Load older conversations' affordance. Clicking it issues a /api/conversations?cursor=… request that returns only rows already in the displayed tail (deduped to nothing, use-team-events.ts:238-241), so the button does nothing visible.

**Why dangerous.** Purely cosmetic — a lingering 'Load older' control that returns nothing on click, plus one wasted (deduped) fetch. NOT data omission (the opposite of chat-load-switch-1's claim): all rows are present; only the end-of-list affordance is wrong. No correctness, no double-send, no missing chat.

**Impact.** Invisible at pilot scale (teams fit in 1-2 pages and rarely shrink across a reconnect). At larger scale the worst case is an agent clicking a no-op 'Load older' button once after a reconnect that coincided with a bulk close/delete. Self-corrects on the next clean filter-change refetch (which does call setNextCursor, use-team-events.ts:314) or page reload.

**Fix.** In resyncOnce, after the page resolves, call setNextCursor(page.nextCursor) — the same reset the loadMore (:243) and filter-change (:314) paths already do. The merged tail can hold rows deeper than the fresh page, so the simplest correct variant is setNextCursor(page.nextCursor) and accept that very-deep rows re-fetch on demand (they dedupe). This is the same one-line change the original chat-load-switch-1 finding proposed, but its real (small) payoff is fixing this stale-affordance nit, not preventing any data gap.


---

## Realtime / WebSocket / Fanout

_This is an exceptionally well-engineered realtime layer — among the most disciplined I've audited. Room topology is clean (team/conversation/channel rooms, all tenant- or membership-gated), and event scoping is correct everywhere I checked: the documented storm vectors (broadcast recipient sends, message:status ticks, broadcast reopens) are all scoped to the conversation room, broadcast progress is throttled to 2/sec, and bulk contact mutations are coalesced into a single contacts:bulk_updated frame. Fanout completeness is compiler-enforced (FANOUT_RULES is a Record keyed by every DomainEventType; every published type has a rule), and the "realtime cache patch matrix" is enforced at runtime in dev via assertReducerCoverage() on BOTH consumers (live hook + LRU shell), driven off a single THREAD_REDUCER_EVENTS table. Auth-on-connect re-runs on every recovered reconnect (closing the deactivation-survival window) and is protected by per-IP handshake buckets, a 15s session cache, and per-socket emit/typing/subscribe/presence token buckets. Presence/typing/viewers use 0→1/1→0 transition gates to avoid multi-tab spam, and are re-snapshotted to the socket on every (re)subscribe. There are no feedback loops, no duplicate-emit paths (publishInTx writes NULL-publishedAt rows dispatched only by the drainer; publish() writes already-published rows the drainer skips), and no cross-tenant leak vectors. The one genuine gap I can substantiate is a narrow first-open recovery hole for conversation-scoped per-message status/media frames; everything else is either correct or a documented, trigger-gated deferral (30s CSR bound, no Redis adapter, per-team fairness in broadcast/webhook workers)._

### ⚪ [Low] realtime-1 — message:status / message:media:ready ticks that fire during the SSR-render → conversation-room-join gap are not recovered on a fresh thread open (only on a real reconnect)

**Location:** apps/web/src/features/inbox/hooks/use-conversation-events.ts:634 (recover = isReconnect ? runFullRefetch : runBackfill), runBackfill at 641-743; server delta at apps/api/src/lib/queries/conversations.ts:516-574; conversation-scoped emit at apps/api/src/realtime/fanout-rules.ts:116-123,145-152

**Problem.** message.status_changed and message.media_ready are deliberately (and correctly) scoped to the conversation room (apps/api/src/realtime/fanout-rules.ts:116-123, 145-152) to avoid a team-room storm. On the client, a fresh thread open follows this sequence: the server component renders the thread at SSR time (messages + their statuses frozen at that instant) → the JS bundle parses/hydrates → useConversationEvents' onConnect fires subscribe:conversation and joins the room → then runs runBackfill (the FIRST-connect path, apps/web/src/features/inbox/hooks/use-conversation-events.ts:590-637, 641-743). runBackfill is a `?after=<cursor>` delta: it re-syncs conversation HEADER state (status/assignment/unread/lastInboundAt via listNewerMessages' `state` field, apps/api/src/lib/queries/conversations.ts:562-573) plus any messages NEWER than the cursor — but it does NOT re-sync the delivery `status` (sent/delivered/read) or media of messages that already existed at SSR time. So if Meta delivers a delivered/read status webhook (or an inbound media download completes) in the window between SSR-render and the browser actually joining the conversation room, that conversation-scoped frame is emitted into an empty room and silently lost. The full-state recovery (runFullRefetch → GET /api/inbox/conversation/:id, which DOES reconcile per-message status, use-conversation-events.ts:761-858) only runs on a real socket RECONNECT (hasConnectedOnceRef true), never on a first open.

**Why dangerous.** A correctly-sent outbound message shows a stale read-receipt checkmark (stuck on 'sent' when it was actually delivered/read), or an inbound media bubble stays on the 'Downloading…' shimmer, on a freshly-opened thread — and it does not self-heal until the agent navigates away and back or the socket genuinely drops and reconnects. It looks like the platform 'lost' a delivery confirmation, undermining trust in read receipts (a core shared-inbox signal).

**Impact.** At current pilot scale: a cosmetic, intermittent stale read-receipt / stuck-media-shimmer on threads opened in the ~hundreds-of-ms-to-few-seconds window where a status tick races the room join (more likely on slow 3G hydration). Read receipts are the most-affected surface; inbound media is less likely to race because the download itself takes seconds (usually longer than the join gap). No data loss — the DB is correct; only the live view of an already-open thread is stale. Does not worsen materially at growth (it's per-open, not per-message-volume).

**Fix.** Carry per-message status/media reconciliation into the first-connect delta path, not just the reconnect full-refetch. Cheapest fix: have the `?after=` backfill endpoint (listNewerMessages) ALSO return a compact `[{id,status,media?}]` array for the messages the client already holds (the client can send the displayed message ids, or the server can return statuses for the last N messages by timestamp), and have runBackfill apply applyMessageStatus / applyMessageMediaReady for each. Alternatively, run runFullRefetch (instead of runBackfill) on first open too, accepting the heavier query — but the targeted status-delta is lighter. Either makes first-open convergence independent of the join-gap timing, matching the guarantee the reconnect path already provides.

**Verifier evidence.** apps/web/src/features/inbox/hooks/use-conversation-events.ts:634 (recover = isReconnect ? runFullRefetch : runBackfill), :595-596 (isReconnect gating), :646-654 (cursor = last server-confirmed), :715-717 (append-only by externalId), :692-713 (header-only resync), :810-818 (status/media reconcile only in runFullRefetch); apps/api/src/lib/queries/conversations.ts:557 (timestamp gt afterDate — excludes displayed msgs); apps/api/src/realtime/fanout-rules.ts:116-123,145-152 (conversation-room scoping); apps/api/src/realtime/realtime.gateway.ts:485-565 (subscribe handler emits typing+viewers only, no status/media snapshot)

---

## Client State Management

_This is an exceptionally well-engineered client-state layer for a solo-built pilot. The "plain React + pure reducers + Socket.io frames" model (no Zustand/React Query — correct, locked) is executed with rigor: every per-thread field has a single source of truth via `thread-reducers.ts`, both consumers (live `useConversationEvents` + LRU cache in `inbox-shell.tsx`) iterate the SAME reducer table, and a dev-only `assertReducerCoverage()` invariant structurally prevents the "missed wiring" stale-state class. The "optimistic socket dispatch" rule (dispatch locally AND let the server fan out) is applied CONSISTENTLY across status, assignment, stage, tag, contact, note, and read — every site I checked (status-dropdown, assignment-dropdown, contact-panel, message-thread, contact-detail-drawer) pairs an optimistic `dispatchLocalSocketEvent(s)` with a matching rollback on PATCH failure, uses `optimistic: true` to suppress redundant resyncs/refetches, and bundles state+activity frames into one `flushSync` to avoid split paints. The inbox reconnect-convergence design (delta `?after=` on first connect, full refetch on real reconnect, visibility/online deferral, recency-guarded list merges, stage-filter overlay self-heal) is genuinely production-grade and matches what the docs claim. The few real findings are bounded staleness gaps on the TEAM-CHAT surface (which, unlike the inbox, has NO reconnect-recovery path) and one narrow SSR-reseed edge — none affect customer-message correctness. Nothing here is a crash, data-loss, or cross-tenant issue._

### 🟡 [Medium] state-management-1 — Team-chat surface has no reconnect-state convergence — the inbox's load-bearing invariant is not mirrored on /team

**Location:** apps/web/src/features/team-chat/hooks/use-team-channel-events.ts:309-348 (onConnect/runBackfill, delta-only); apps/web/src/features/team-chat/components/team-chat-workspace.tsx:44-70 (no onRecovered/useConnectionStatus)

**Problem.** The inbox enforces a hard rule (CLAUDE.md: "Every recovery path must converge to server state") via runFullRefetch on real reconnect + resyncWithBackoff + a visibility resync. The /team surface implements NONE of this. `useTeamChannelEvents` (apps/web/src/features/team-chat/hooks/use-team-channel-events.ts:312-320) re-subscribes on every `connect` but ALWAYS runs only the delta `?after=<latest createdAt>` backfill — there is no first-connect-vs-reconnect distinction and no full refetch. The delta endpoint returns only NEW messages; it cannot carry edits, reactions, pins, deletes, or thread-reply-count changes to messages ALREADY in the loaded slice. So if a teammate edits/deletes/reacts-to/pins a message that is on screen while this tab is dropped longer than Socket.io's 30s connection-state-recovery window, those frames are lost and never recovered until the user navigates to another channel (which re-SSRs). There is also no `useConnectionStatus({ onRecovered })` / softRefresh wired anywhere on /team (confirmed: grep found zero useConnectionStatus/ConnectionBanner mounts under app/(app)/team or features/team-chat).

**Why dangerous.** An agent reading a channel through a laptop-sleep / wifi-hop sees a stale message body (post-edit), a still-present deleted message, a wrong reaction count, or a missing pin, with no banner indicating the surface is stale and no self-heal. The same agent's inbox tab WOULD self-heal — the inconsistency between the two surfaces is itself a maintenance hazard (a future dev assumes the team-chat hook has the same guarantees the inbox hook documents).

**Impact.** At current pilot scale (one customer, small team) this is low-frequency: it only bites on a >30s socket drop while parked on one channel AND a teammate mutates a loaded message during the gap. At growth (20+ agents, busy channels, frequent deploys causing synchronized reconnects) it becomes a recurring 'why does the team channel show a deleted/edited message until I click away' report. Bounded — internal collaboration data, never customer messages.

**Fix.** Mirror the inbox pattern at minimal cost: add a `hasConnectedOnceRef` to `useTeamChannelEvents`, and on a SUBSEQUENT connect run a full channel refetch (GET the channel's latest page + replace/merge) instead of the delta — the same runFullRefetch shape useConversationEvents already uses. Cheapest alternative: wire `useConnectionStatus({ onRecovered: softRefresh })` once in team-chat-workspace.tsx so a recovery triggers a router.refresh() that re-SSRs the channel + sidebar (team chat is RSC-fresh on navigation anyway, so this reuses the existing fresh-on-nav model).

**Verifier evidence.** apps/web/src/features/team-chat/hooks/use-team-channel-events.ts:312-348 (onConnect→delta-only runBackfill); contrast apps/web/src/features/team-chat/hooks/use-team-events.ts:539-548 (resyncWithBackoff on non-first connect) + :946-956 (visibility resync); apps/api/src/realtime/ws-adapter.ts:59 (30s recovery bound); apps/web/src/app/(app)/layout.tsx:55 (CatalogSyncBoundary — partial, event-driven not reconnect-driven)

### 🟡 [Medium] state-management-2 — Team-chat channel sidebar (unread dots + previews) has no socket `connect` listener — no reconnect recovery at all

**Location:** apps/web/src/features/team-chat/hooks/use-team-channels-events.ts:47-141 (effect binds onMessage/onRead/onCatalog/onMembersChanged but no `connect`)

**Problem.** `useTeamChannelsList` (apps/web/src/features/team-chat/hooks/use-team-channels-events.ts:47-141) subscribes to team:channel:message, team:channel:read, team:catalog:changed, and team:channel:members:changed — but NOT to `connect`. The inbox list hook (`useTeamEvents`) deliberately DOES subscribe to connect and runs `resyncWithBackoff()` plus a visibility-triggered `runCoalescedResync()` precisely because a backgrounded/throttled tab or a reconnect-after-drop silently misses live frames (most importantly a teammate's read clearing an unread dot). The channels-list hook re-seeds only from server props (`signatureOf(initial)` at line 35-40), which changes only on a server NAVIGATION (channel switch) — not on a socket reconnect. So while an agent stays on one channel through a drop > 30s, OTHER channels' sidebar unread dots / previews / mention counts that changed during the gap stay stale with no recovery.

**Why dangerous.** Unread/mention state is a triage signal. A stuck unread dot (teammate read it during the gap → conversation:read frame missed → dot never clears) or a stale preview undermines trust in the sidebar exactly the way the inbox's now-fixed 'stuck unread badge' bug did — and this is the same bug class the inbox already learned to fix, left unfixed on this surface.

**Impact.** Pilot scale: rare (needs a >30s drop while parked on a channel). Growth/deploy churn: synchronized reconnects after every deploy leave every parked tab's non-active channels stale until a new frame or a manual channel switch. Bounded to internal team chat.

**Fix.** Add a `connect` listener that, on a non-first connect, refetches GET /api/team/channels and re-seeds (the same one-GET approach onCatalog already uses at line 97-108), guarded by a first-connect skip flag. Optionally add the visibility-resync the inbox list uses. This reuses existing endpoints; ~15 lines.

**Verifier evidence.** apps/web/src/features/team-chat/hooks/use-team-channels-events.ts:47-141 (effect binds onMessage/onRead/onCatalog/onMembersChanged at :130-133, no `connect`); :35-40 (signatureOf re-seed only on server-prop change); contrast use-team-events.ts:547 socket.on("connect", onConnect)

### ⚪ [Low] state-management-3 — Inbox list SSR re-seed can discard live socket state when the top-N conversation ID set shifts on a router.refresh()

**Location:** apps/web/src/features/team-chat/hooks/use-team-events.ts:176-187 (lastSeedKeyRef re-seed); trigger path apps/web/src/hooks/use-catalog-sync.ts:100-126

**Problem.** `useTeamEvents`'s re-seed effect (apps/web/src/features/team-chat/hooks/use-team-events.ts:176-187) keys on `${teamId}|<conversation ids joined>|<cursor>`. When `useCatalogSync` fires `router.refresh()` (on any tag/stage/field/member/workflow catalog change — see use-catalog-sync.ts), page.tsx re-runs server-side and produces a fresh `initialConversations`. If the recency-ordered top-30 ID SET is unchanged, the re-seed correctly bails and preserves live state. But if the set changed (a new conversation entered, or one dropped out of the top-30 window between mount and the refresh), the effect REPLACES `conversations` wholesale with the SSR snapshot (filtered through the current filter). That snapshot can be a beat behind live socket state: optimistically-spliced filtered rows, locally-cleared unread counts, and live previews that the SSR query didn't capture get overwritten by server values.

**Why dangerous.** A catalog change (common, e.g. an agent adds a tag) can momentarily regress the conversation list to a slightly-staler server snapshot — e.g. an unread count the agent just cleared flashes back, or a row the agent optimistically moved disappears — until the next live frame reconciles. It's self-healing and the comment block documents the recency-id keying as a deliberate tradeoff, so this is a known edge, not a hidden bug.

**Impact.** Pilot scale: nearly invisible (catalog changes are infrequent and the ID-set must change in the same window). Growth: more agents → more catalog churn → more chances to catch a transient regress. Bounded; reconciles on the next socket frame.

**Fix.** If it ever surfaces as a real complaint: on re-seed, reconcile the SSR rows against the current live `conversations` the same way the filter-change refetch already does (use-team-events.ts:291-313 keeps the local row's preview/recency when local.lastMessageAt is strictly newer) instead of a wholesale replace. Until then, leave it — the cost of a broader merge isn't justified at one customer.

**Verifier evidence.** apps/web/src/features/team-chat/hooks/use-team-events.ts:177-187 (wholesale re-seed, no overlay/recency reconciliation) vs :291-313 (filter-change refetch DOES keep strictly-newer local preview) and :410-423 (resyncOnce DOES overlay latestContactRef); trigger apps/web/src/hooks/use-catalog-sync.ts:113 (startTransition(router.refresh))

### ⚪ [Low] state-management-4 — Inbox conversation-list hook lives in features/team-chat/ — misleading locality for the single most important inbox state owner

**Location:** apps/web/src/features/team-chat/hooks/use-team-events.ts:78 (export useTeamEvents — inbox list owner); imported at apps/web/src/features/inbox/components/inbox-shell.tsx:23

**Problem.** The hook that owns the entire inbox conversation-LIST state (`useTeamEvents`, 977 lines) physically lives at apps/web/src/features/team-chat/hooks/use-team-events.ts and is imported by inbox-shell.tsx:23. It has nothing to do with team chat — it manages customer-conversation list state, filters, recency sort, unread badges, and the optimistic splice-in/out logic. The actual team-chat list hook is the separate `useTeamChannelsList` in the same directory. This is purely a naming/locality issue, not a behavioral bug, but it's the kind of misfile that causes a future change to the inbox list to be made against the wrong file, or a team-chat refactor to accidentally touch inbox-critical code.

**Why dangerous.** Not dangerous at runtime. The risk is maintenance: the project's own 'realtime cache patch matrix' and reconnect-convergence rules are split across files whose names don't match their responsibility, raising the chance a future edit lands in the wrong place — exactly the failure mode the codebase otherwise defends against with assertReducerCoverage.

**Impact.** Zero runtime impact now or at scale. Pure code-organization debt.

**Fix.** Move the hook to apps/web/src/features/inbox/hooks/use-inbox-list-events.ts (or similar) and update the single import in inbox-shell.tsx. Keep `useTeamChannelsList` where it is. Do this only as part of unrelated inbox work — it's a rename, not a fix.

**Verifier evidence.** apps/web/src/features/team-chat/hooks/use-team-events.ts:78 (export function useTeamEvents — inbox customer-conversation list owner); imported apps/web/src/features/inbox/components/inbox-shell.tsx:23, used :538

### ⚪ [Low] state-management-5 — Team-chat thread side-panel has a literally no-op reconnect handler — NEW thread replies arriving during a >30s drop are permanently lost

**Location:** apps/web/src/features/team-chat/hooks/use-thread-events.ts:115-118 (no-op onConnect, no backfill); only fetch at :51-78 (mount/root-change); apps/api/src/realtime/ws-adapter.ts:59 (30s recovery bound)

**Problem.** useThreadEvents binds an onConnect that is an explicit no-op (use-thread-events.ts:115-118 — body is just a comment 'no-op kept for symmetry'), with NO reconnect backfill of any kind. The only fetch of thread replies is the mount/root-change effect (:51-78). Live new replies arrive via the team:channel:message socket handler (:120-138). So if a thread side-panel is open and the socket drops longer than Socket.io's 30s connectionStateRecovery window (ws-adapter.ts:59), any thread replies, edits, deletes, or reactions that land during the gap are never recovered — there is not even the `?after=<latest>` delta that the sibling channel hook (use-team-channel-events.ts:322-348) runs on reconnect. This is strictly WORSE than the channel-feed gap in state-management-1: the channel hook at least re-fetches NEW messages on reconnect; the thread panel recovers nothing until the user closes and reopens the panel (which re-triggers the mount fetch).

**Why dangerous.** A thread panel parked open through a laptop-sleep / wifi-hop shows a frozen reply list — a teammate's answer to the threaded question is invisible with no indication the panel is stale and no self-heal. Because the panel re-fetches on root-message change but never on reconnect, the user has no obvious recovery action (scrolling/loadMore only paginates the already-loaded slice via the cursor; it won't surface replies newer than the stale tail). Same internal-collaboration bug class as state-management-1/2, just unrecovered entirely.

**Impact.** Pilot scale: rare (needs a >30s drop while a thread panel is open AND a reply lands during the gap). Growth/deploy churn: every synchronized reconnect leaves open thread panels frozen until closed/reopened. Bounded to internal team chat — never customer messages.

**Fix.** Give onConnect a real reconnect backfill: on a non-first connect (guard with a firstConnectRef like useTeamEvents:537-544), re-fetch the thread's tail via the existing GET /api/team/channels/:channelId/messages/:rootMessageId/thread?after=<latest reply createdAt> and merge-dedupe by id — the same delta shape use-team-channel-events.runBackfill already uses (:322-348). ~12 lines, reuses an existing endpoint.


---

## Media (image/video/audio/voice/file) + WhatsApp Calling

_The media subsystem is genuinely strong and production-grade. Inbound media uses a clean async download flow (sub-100ms bubble paint, retry-with-backoff, CAS-guarded patch, shutdown drain, sweeper backstop) with no torn-row races; the blob-storage layer has a real mime allowlist, magic-byte signature sniffing (SVG XSS exclusion), SSRF guards, streaming size caps, and upload timeouts; the audio path correctly strips codec params, transcodes voice notes to ogg/opus via a safe arg-array ffmpeg spawn with timeout+output-cap, and gates the iOS voice profile behind an env flag. The WhatsApp Calling feature is impressively careful on the SERVER side — CAS-gated answer/reject/end, terminal-state idempotency guards in ingest, orphan-Meta-call teardown on local-insert failure, the BIC/region/24h/5-per-day gauntlet, and correct duration computation. The real risks are concentrated on the BROWSER call lifecycle: there is no teardown on component unmount (SPA navigation mid-call leaks the mic + live RTCPeerConnection and never ends the call server-side), and no client-side ring timeout on either the outbound panel or the incoming-call toast (a dropped terminal socket frame strands a "ringing" panel with an open mic or a phantom incoming toast). A bounded /tmp leak also exists on idempotency-replayed media uploads. None of these are cross-tenant or data-loss; the calling ones are the highest priority because they involve a hot mic and a live customer call._

### 🟠 [High] media-calls-1 — Active call is never torn down when the inbox page unmounts (SPA nav mid-call leaks mic + RTCPeerConnection, no server /end)

**Location:** apps/web/src/features/calls/hooks/use-call.ts:194-285 (no unmount teardown effect); mount site apps/web/src/features/inbox/components/inbox-shell.tsx:265 + apps/web/src/app/(app)/inbox/layout.tsx

**Problem.** useCall() is mounted inside InboxShell (the inbox PAGE, per apps/web/src/app/(app)/inbox/layout.tsx rendering children → page → InboxShell), not the app layout. In use-call.ts the only useEffect cleanups are socket.off() (lines 240-243) and removing the hidden <audio> element (lines 255-258). There is NO effect whose cleanup calls tearDown(). So if an agent is on a live call and navigates within the SPA to /contacts, /broadcasts, /settings, etc., the inbox page unmounts: pcRef's RTCPeerConnection is never close()'d, localStreamRef's mic tracks are never stop()'d, and no POST /api/calls/:id/end is fired. The beforeunload/pagehide handler (lines 266-285) only fires on a full document unload, not React route changes.

**Why dangerous.** The agent's microphone stays open and the outbound audio track keeps flowing to the customer after the agent has visually left the call. The call also stays in_progress server-side (no /end), so the timeline never gets a terminal row and the team-wide 'ongoing call' state is stuck until the customer hangs up or Meta's ICE/keepalive eventually fails (~15-30s+). A hot mic with no visible call UI is a privacy problem, not just a resource leak.

**Impact.** Bites now at pilot scale: an agent juggling tabs/sections during a call (extremely common in a shared inbox) leaks the mic and strands the call. At growth this multiplies and also leaves zombie in_progress Call rows skewing any future call analytics.

**Fix.** Add a final useEffect in useCall whose cleanup tears the call down on unmount, e.g. `useEffect(() => () => { const live = liveCallRef.current; if (live && !live.callId.startsWith('tmp_')) { navigator.sendBeacon?.(`/api/calls/${live.callId}/end`, new Blob([JSON.stringify({})], {type:'application/json'})); } tearDown(); }, [tearDown]);`. sendBeacon survives the synchronous unmount; tearDown closes the PC and stops the mic. Alternatively hoist useCall into the (app) layout so it isn't unmounted by inbox-internal navigation, but the unmount-teardown is still needed for logout/route-away.

**Verifier evidence.** apps/web/src/features/calls/hooks/use-call.ts:169-192 (tearDown), 240-285 (all cleanups, none call tearDown); apps/web/src/features/inbox/components/inbox-shell.tsx:265 (sole useCall mount); apps/web/src/app/(app)/inbox/layout.tsx + apps/web/src/app/(app)/layout.tsx (inbox is an unmountable subtree)

### 🟡 [Medium] media-calls-2 — No client-side ring timeout on outbound call panel or incoming-call toast — a dropped terminal socket frame strands a 'ringing' UI with an open mic

**Location:** apps/web/src/features/calls/hooks/use-call.ts:413-511 (initiateOutbound, no timeout) and apps/web/src/features/calls/components/incoming-call-toast.tsx:39-78 (no auto-expire)

**Problem.** Neither use-call.ts nor call-panel.tsx nor incoming-call-toast.tsx has any ringing timeout. On an OUTBOUND call, initiateOutbound() opens the mic (setupPeer → getUserMedia) and sets liveCall.status='ringing' optimistically. If the customer never answers, teardown depends entirely on receiving a server frame: call:ended (from Meta's terminate webhook → ingest → fanout) OR the PC's onconnectionstatechange reaching failed/disconnected. But a never-answered call's PC sits in 'connecting'/'new' (no remote answer was ever applied), so onconnectionstatechange may not fire for a long time, and if the call:ended socket frame is missed (transient socket drop, throttled background tab, the documented 30s connection-state-recovery window being exceeded), the panel stays 'ringing' with the mic live indefinitely. Symmetrically, IncomingCallToast (incoming-call-toast.tsx) only removes a card on call:answered/call:ended — there is no auto-expire, so a missed terminal frame leaves a phantom 'Customer is calling you' card forever.

**Why dangerous.** Open mic with a UI that says 'Calling…' but the call is dead; or a permanent fake incoming-call toast that an agent may click to answer a call that no longer exists. Both depend on a single non-redelivered socket frame, which the codebase explicitly acknowledges can happen (one-shot frames + 30s recovery bound).

**Impact.** Low frequency now (needs a missed terminal frame during a ring), but the failure mode is bad (hot mic / phantom toast) and self-perpetuating until a manual refresh. WhatsApp/Meta typically rings ~30s before auto-terminating, so a bounded timeout is a natural backstop.

**Fix.** Add a ringing watchdog: when liveCall enters 'ringing', start a ~45-60s timer; on fire, POST /end (if non-tmp) and tearDown with a 'No answer' toast. For the incoming toast, store ringingAt and auto-remove a card after ~60s (Meta stops ringing well before then). Clear the timers on status change / unmount.

**Verifier evidence.** apps/web/src/features/calls/hooks/use-call.ts:449-457 (ringing set, no timer), 291-337 (setupPeer opens mic, onconnectionstatechange only fires on PC state change); apps/web/src/features/calls/components/call-panel.tsx:43-47 (only a duration ticker); apps/web/src/features/calls/components/incoming-call-toast.tsx:39-78 (no auto-expire); apps/api/src/lib/sweepers/ (no call ring-timeout sweeper)

### 🟡 [Medium] media-calls-3 — Idempotency-replayed media uploads leak the multipart temp file in /tmp

**Location:** apps/api/src/messages/messages.service.ts:988-1031 (idempotency wrapper vs inner-finally unlink); apps/api/src/messages/send-idempotency.ts:75-78 (short-circuit); apps/api/src/messages/messages.controller.ts:95-116 (controller does not unlink)

**Problem.** The temp-file unlink lives in sendMediaInner's finally block (messages.service.ts:1015-1029), which only runs when work() actually executes. But sendMedia() wraps sendMediaInner inside runWithSendIdempotency() (messages.service.ts:988-1004), and runWithSendIdempotency short-circuits to a CACHED promise for any repeat of the same (teamId,userId,conversationId,clientTempId) within a 5-minute TTL WITHOUT calling work() (send-idempotency.ts:75-78). Multer's FileInterceptor (messages.controller.ts:82-94, diskStorage) has ALREADY written the second request's multipart body to a fresh temp file on disk by the time the service is invoked. On the idempotency-hit path, sendMediaInner never runs, its finally never unlinks, and that second temp file is orphaned in tmpdir(). The controller does not unlink either.

**Why dangerous.** Every same-clientTempId media retry (network blip causing a client re-POST, double-submit, a second tab) leaves up to one full media payload (up to 100 MiB for documents) sitting in /tmp on the single VPS. The disk-fill failure mode is exactly the kind that took down the box before (the removed systemd unit not pruning images).

**Impact.** Bounded but real now: a flaky-network agent re-sending a large file accumulates orphan temp files across a shift on a small VPS. No OS-level /tmp cleanup is configured in the container. Grows with media volume and number of agents.

**Fix.** Move the temp-file unlink OUT of sendMediaInner and into the controller's handler (finally around the service call) OR pass a cleanup callback that always runs, so the file is unlinked regardless of whether the idempotency layer short-circuited. Simplest: in messages.controller.ts sendMedia, wrap `await this.messages.sendMedia(...)` in try/finally that unlinks file.path — the controller always has the freshly-parsed file even on an idempotency hit.

**Verifier evidence.** apps/api/src/messages/messages.service.ts:988-1004 (idempotency wrapper) vs 1015-1030 (unlink in inner finally); apps/api/src/messages/send-idempotency.ts:76-78 (short-circuit without work()); apps/api/src/messages/messages.controller.ts:95-116 (no unlink), 86-92 (diskStorage writes temp before service runs)

### ⚪ [Low] media-calls-4 — Customer's raw call SDP (offer for inbound, answer for outbound) is fanned to the entire team room

**Location:** apps/api/src/realtime/fanout-rules.ts:627-634; apps/web/src/features/calls/hooks/use-call.ts:199-226

**Problem.** fanout-rules.ts:627-634 emits call.sdp_offer to emitToTeam — the whole tenant's agent room — carrying the customer's full SDP (ICE candidates with public/relay IPs, DTLS fingerprints, media crypto setup). For inbound calls every agent stashes the offer in pendingOffersRef (use-call.ts:219-225); for outbound calls every agent receives the customer's answer SDP (only the matching agent applies it, the rest stash-then-GC). The comment justifies team-wide fanout to dodge the 'agent A clicked answer but the SDP went to agent B' race.

**Why dangerous.** This is NOT a cross-tenant leak (it is team-scoped, and the team is one customer org). But it broadcasts a live customer's network-level call metadata to every connected agent in the org, including agents with no role in the call. It is a minor over-exposure and slightly widens the surface for a compromised/curious agent session.

**Impact.** Negligible at pilot scale (one small team). Worth a note rather than a fix — same-tenant exposure of signaling data, not media content (DTLS-SRTP keys are negotiated per-PC, so a bystanding agent cannot decrypt the audio).

**Fix.** If tightened later: scope call.sdp_offer to the conversation room (with a deterministic answerer) or to the specific answering agent's socket once known. Given the documented answer-race rationale and the locked 'team-wide for incoming' model, leaving it is defensible — flagging for awareness only. Do not block the pilot on this.

**Verifier evidence.** apps/api/src/realtime/fanout-rules.ts:627-634 (emitToTeam with e.sdp); apps/web/src/features/calls/hooks/use-call.ts:199-236 (every agent receives + stashes); apps/api/src/lib/providers/ingest-call.ts:429-453 (SDP forwarded for both inbound offer + outbound answer)

### ⚪ [Low] media-calls-5 — answerIncoming with a not-yet-arrived offer fails with a 'still connecting' error and does not auto-retry when the offer lands

**Location:** apps/web/src/features/calls/hooks/use-call.ts:343-351; apps/web/src/features/calls/components/incoming-call-toast.tsx:91-99

**Problem.** In answerIncoming (use-call.ts:343-351), if pendingOffersRef has no entry for callId (the call:sdp_offer frame hasn't arrived yet, or was missed), it sets error 'Hold on — the call is still connecting.' and returns. There is no deferred-answer mechanism: if the offer arrives a moment later, nothing re-attempts the answer. The agent must click Answer again, and the incoming toast was already optimistically dismissed (incoming-call-toast.tsx:97), so there is no card left to click.

**Why dangerous.** On a slightly-delayed or briefly-dropped call:sdp_offer frame, the agent clicks Answer, sees an error, and the toast is gone — the only recovery is the customer re-ringing. The offer frame is delivered separately from call:incoming, so a small ordering/timing gap is plausible.

**Impact.** Minor UX, low frequency. Customer experiences a missed pickup; agent sees a transient error. No data or state corruption.

**Fix.** Either don't dismiss the toast card until the answer POST succeeds (keep it, just disable the buttons during connect), or stash a 'pending answer intent' for callId and auto-run answerIncoming when the matching call:sdp_offer arrives. Re-arming the toast on failure is the smallest fix.

**Verifier evidence.** apps/web/src/features/calls/hooks/use-call.ts:346-350 (no-offer early return via setError, no deferral); apps/web/src/features/calls/components/incoming-call-toast.tsx:91-99 (optimistic dismiss); apps/web/src/features/calls/components/call-panel.tsx:54 (returns null when liveCall null, so error invisible); apps/api/src/lib/providers/ingest-call.ts:323-333,441-453 (incoming + sdp co-published in one tx)

---

## Workflow Engine / Automations / Triggers

_The workflow engine is genuinely well-engineered and the strongest dimension I'd expect to audit on this codebase. Loop/storm defenses are layered and largely correct: graph-level DAG cycle detection at publish time, an immutable graphSnapshot pinned at run-creation, THREE complementary loop ceilings (distinct-step count, per-pickup execution count, and persisted jumpsUsed), per-step crash-recovery journaling (in_progress → skipped_after_crash) honoring CLAUDE.md rule #3, a per-conversation send budget as the loop backstop, the X-CCP-Depth cross-system cap AND the workflowDepth in-process chain cap (both = 8, both correctly propagated through trigger_workflow), fail-closed condition evaluation with regex-DoS length caps, bounded BullMQ retries (attempts:3 + exponential backoff), a boot-time assertion that lockDuration > maxStepTimeout + margin, graceful worker drain bounded under stop_grace_period, and two recovery sweepers (workflow-waiting, awaiting-reply). Every mutation step is disciplined about publishing `silent: true` so step-driven changes never re-trigger workflows. The findings below are narrow: one real (but narrow-window) concurrent-double-execution race on the ask_question resume path that the code's own comments acknowledge but don't fully close, a node-cap-vs-step-ceiling mismatch that can fail valid large workflows at runtime, and the test-on-draft feature being silently no-op'd by the runner's published gate._

### 🟡 [Medium] workflows-1 — ask_question resume has no per-run mutual exclusion — inbound reply ≈ timeout race can double-execute the post-question step (irreversible double-send)

**Location:** apps/api/src/lib/workflows/runner.ts:142-145 (unconditional 'running' set, no CAS); runner.ts:101-140 (guards that don't cover simultaneous fire); apps/api/src/lib/workflows/queue.ts:158-175 (inbound + timeout jobs not mutually exclusive); apps/api/src/lib/workflows/worker.ts:120-158 (per-team slot, not per-run); prisma/schema.prisma model WorkflowRun (no version/lock column)

**Problem.** A WorkflowRun is processed with NO per-run lock. The only concurrency control is the per-team slot cap (worker.ts tryAcquireTeamSlot, default 2), which does not prevent two BullMQ jobs that target the SAME runId from running runWorkflow() concurrently. The runner sets status to 'running' with an unconditional update (runner.ts:142-145) — there is no compare-and-swap on prior status and no version/lock column on WorkflowRun (confirmed in prisma/schema.prisma model WorkflowRun, no version field). For an ask_question step the runner enqueues a long-delay timeout job `resume-${runId}-${waitSeq}` (runner.ts:552). When the contact replies, ingest writes pendingAnswer and enqueues a SEPARATE job `inbound-${runId}-${messageId}` (queue.ts:164-175, ingest.ts:821). BullMQ locks per-job, not per-run (acknowledged in queue.ts:160-162 and runner.ts:116-119). If the reply lands at roughly the same moment the timeout fires, BOTH jobs run: the inbound one bypasses the stale-resume guard (isInboundResume=true), and the timeout one passes the stale guard because now >= waitUntil. Both load the run (status=waiting, pendingAnswer set), both re-execute ask_question on the resume branch, both select the 'answered' edge and advance to the NEXT step, executing it twice. The per-step in_progress journal does NOT help: it is a sequential-retry crash-recovery mechanism — both pickups read the same stepLog snapshot at load time (before either writes in_progress), so neither sees the other's in-flight entry, and the orphan-detect only fires on a prior in_progress WITHOUT a terminal entry (the prior ask_question entry is 'waiting', not 'in_progress').

**Why dangerous.** If the step after ask_question is send_message/send_template/ask_question, the customer receives the message TWICE — an irreversible Meta send, exactly the failure class CLAUDE.md rule #3 exists to prevent. trigger_workflow would dispatch a child run twice; http_request would POST a partner endpoint twice. The conversation-send-budget (30/min/conversation) only bounds a runaway loop, not a single 2x double-fire (count goes 30→29→28, second send is not blocked). The code's own comments claim the runner-side guard prevents this, but the guard only covers the case where the run has ALREADY advanced to a LATER wait or terminal state — it does not cover the simultaneous-fire case.

**Impact.** At current pilot scale: narrow window (contact must reply within the BullMQ pickup window of the timeout firing — minutes-wide at most, and only for workflows that USE ask_question with a downstream send). Rare but real, and when it hits it is a duplicate customer-facing WhatsApp message or duplicate partner POST. At growth (more ask_question flows, higher reply volume, more worker concurrency) the race surface widens linearly.

**Fix.** Add a per-run CAS on pickup: change the 'running' transition (runner.ts:142) to `db.workflowRun.updateMany({ where: { id: run.id, status: { in: ['queued','waiting','running'] }, /* and not already claimed this generation */ }, data: { status: 'running' } })` guarded by a monotonically-increasing claim token, OR add an `executionLock`/`version` column to WorkflowRun and CAS on it so the second concurrent pickup's update affects 0 rows and that pickup returns early. The cheapest robust fix: a short Redis SET NX lock keyed `wf-run-lock:${runId}` acquired at the top of runWorkflow (TTL ~= lockDuration) and released in finally — Redis is already required for the queue. Cancel the dangling timeout job on the inbound resume path instead of leaving it (queue.ts:158 'nothing cancels it') as defense-in-depth.

**Verifier evidence.** prisma/schema.prisma:1334-1406 (no version/lock column on WorkflowRun); runner.ts:142-145 (unconditional 'running' set); runner.ts:133-140 (guard fails to cover now>=waitUntil); queue.ts:158-175 (inbound + timeout jobs distinct jobIds, not mutually exclusive); worker.ts:48-50,70-73,161 (concurrency 5, per-team 2, no per-run gate); resume-on-inbound.ts:67-77 + ingest.ts:818-826 (commit-then-enqueue); ask-question.ts:245-337 (resume branch advances on pendingAnswer); conversation-send-budget.ts:38 (30/min, no 2x block)
  _(verdict: partially_confirmed)_

### 🟡 [Medium] workflows-2 — Graph node cap (200) exceeds the runtime distinct-step ceiling (100) — a valid published workflow can fail mid-run as if it were a loop

**Location:** apps/api/src/lib/workflows/graph.ts:128 (MAX_WORKFLOW_NODES=200); apps/api/src/lib/workflows/runner.ts:28 (MAX_STEPS_PER_RUN=100), runner.ts:237 (while guard), runner.ts:636-651 (fail-on-ceiling)

**Problem.** validateGraph allows publishing a workflow with up to MAX_WORKFLOW_NODES = 200 nodes (graph.ts:128,141). But the runner's MAX_STEPS_PER_RUN = 100 (runner.ts:28) caps the number of DISTINCT steps that reach a terminal outcome (progressCount, runner.ts:233-235, while-loop guard at 237). A perfectly valid, acyclic workflow whose execution path traverses 101–200 distinct steps will run the first 100 steps, then exit the while loop with currentStepId still set, and be marked FAILED with errorMessage 'step ceiling (100) exceeded' (runner.ts:636-651). There is no publish-time check reconciling the two limits.

**Why dangerous.** The failure looks identical to a loop-guard trip, so an operator debugging it is sent down the wrong path ('why does my flow think it's looping?'). The work done by the first 100 steps already fired (real Meta sends, tag changes, field writes) but the run is reported failed and the remaining ~100 steps silently never execute — a partial, non-obvious execution with no clear signal that the cause is the node count, not a cycle.

**Impact.** Edge case at pilot scale — most workflows are well under 100 steps (the canvas docs target 'a few dozen'). But the builder explicitly permits up to 200 nodes, so a power user CAN hit it, and when they do the diagnosis is misleading and the side effects are half-applied. No data loss, bounded blast radius.

**Fix.** Either (a) lower MAX_WORKFLOW_NODES to <= MAX_STEPS_PER_RUN so the publish gate refuses graphs the runner can't finish, or (b) raise MAX_STEPS_PER_RUN to cover the 200-node cap (a 200-step linear run is cheap — 200 small JSONB updates — though the per-pickup execution counter and jumpsUsed cap still protect against true loops), or (c) add a publish-time validation error when a graph's longest simple path exceeds the runtime ceiling. (a) is simplest and matches the 'a few dozen steps' design intent. Also distinguish the failure message: only call it a 'jump_to_step loop' when executedThisPickup tripped, and call the distinct-step overflow 'workflow too large to complete in one run' rather than implying a loop.

**Verifier evidence.** graph.ts:128 (MAX_WORKFLOW_NODES=200), graph.ts:141-146 (publish cap), graph.ts:130-249 (no path-length check); runner.ts:28 (MAX_STEPS_PER_RUN=100), runner.ts:233-237 (progressCount distinct-step guard), runner.ts:636-651 (fail-on-ceiling with 'step ceiling (100) exceeded')

### 🟡 [Medium] workflows-3 — Test-run on a DRAFT workflow is silently skipped — the documented 'test a draft from the canvas' feature is a no-op

**Location:** apps/api/src/team/workflows/workflows.service.ts:506-605 (test creates+enqueues a run for drafts); apps/api/src/lib/workflows/runner.ts:72-76 (runner markSkipped on !published)

**Problem.** WorkflowsService.test() creates a WorkflowRun for any workflow (draft or published) and enqueues it, with the explicit doc-comment 'Skips the dispatcher entirely so a draft workflow (published=false) can still be test-run from the canvas' (workflows.service.ts:506-605). But the runner re-loads the live Workflow on pickup and short-circuits with markSkipped('workflow unpublished or deleted') whenever `!wf.published` (runner.ts:72-76). Since a draft has published=false, every test run on a draft is marked 'skipped' without executing a single step. The published gate is read live (by design — schema comment at WorkflowRun.graphSnapshot says 'published live/draft gate is still read live'), so the test path cannot bypass it.

**Why dangerous.** The feature the admin relies on to validate a workflow BEFORE publishing silently does nothing — the run row shows status 'skipped' with a misleading 'unpublished or deleted' message. Admins may publish untested graphs believing the test passed, or be confused why their test produced no sends/no step log.

**Impact.** Not a loop/storm/double-send risk — a feature-correctness gap. At pilot scale it undermines the safe-iteration workflow (test-before-publish), pushing testing onto published workflows against real contacts. No data loss.

**Fix.** Make the runner accept test runs on drafts: either add a `isTest`/`bypassPublishGate` flag on WorkflowRun (set by test()) that the runner honors to skip the !published short-circuit, OR have test() only run when the workflow is published and surface a clear UI error for drafts. Given the documented intent is to test drafts, the flag approach is correct — gate it so ONLY explicit test runs bypass the published check, never dispatch()/manual/webhook-created runs.

**Verifier evidence.** workflows.service.ts:507-510 (doc claims drafts test-runnable), workflows.service.ts:517-521 (no published filter), workflows.service.ts:590-604 (creates+enqueues regardless); runner.ts:73-76 (markSkipped on !published); apps/web/src/features/workflows/components/builder/workflow-builder.tsx:210-211,243-256 (UI fires /test on drafts, shows success); dispatcher.ts:324-326 (manual path correctly refuses drafts); grep isTest/bypassPublish → none

### ⚪ [Low] workflows-4 — orphan-detect (skipped_after_crash) on ask_question advances via an arbitrary outgoing edge

**Location:** apps/api/src/lib/workflows/runner.ts:283-307 (orphan advance via findNextStep no-label); apps/api/src/lib/workflows/graph.ts:277-278 (outs[0] fallback for label-only nodes)

**Problem.** When a worker dies between writing the in_progress journal and the side effect returning, the next retry's orphan-detect (runner.ts:270-307) presumes the side effect fired and advances via `findNextStep(graph, node.id)` with NO label. For an ask_question node the only outgoing edges are labeled (answered / timeout / option-ids) — there is no unlabeled 'default' edge. findNextStep then falls back to `outs[0]` (graph.ts:277-278), i.e. an arbitrary edge (whichever happens to be first in the edges array). So a crashed ask_question is presumed-sent and routed down a non-deterministic branch rather than re-asking or pausing.

**Why dangerous.** The chosen branch is whatever edge is first in the persisted edges array — effectively arbitrary and not author-intended. A crash mid-ask_question could route the contact down the 'answered' path when they never answered, or vice-versa, leading to a wrong downstream action.

**Impact.** Very narrow — requires a worker crash in the exact window between the in_progress write and the Meta send returning, AND the step being ask_question specifically. The 'presumed sent, manual reconcile' tradeoff is the documented and correct default for sends; the branch-selection on resume is the only quirk. Bounded, rare, no double-send (it advances, not re-runs).

**Fix.** For ask_question specifically, on orphan-detect prefer the 'timeout' edge (the conservative branch — treat a crashed unanswered question as unanswered) rather than outs[0]; or re-pause the run on the same step rather than advancing, since the question may not actually have been delivered. Document the chosen behavior in the orphan-detect block.

**Verifier evidence.** ask-question.ts:123 (sideEffect irreversible); runner.ts:283-307 (orphan advance via findNextStep no-label); runner.ts:315-330,371,511-520 (in_progress lifecycle for ask_question); graph.ts:174-195 (ask_question edges all labeled); graph.ts:277-278 (outs[0] fallback for label-only nodes)

---

## Integrations & Webhooks (inbound Meta + outbound + external API)

_This dimension is genuinely strong — among the most carefully-engineered parts of the codebase. The inbound Meta webhook does HMAC-SHA256 over the EXACT raw body (captured via bodyParser.verify in main.ts), returns 403 on bad sig, 200 fail-soft on malformed/poison payloads to avoid Meta retry-storms, 503 only on transient DB faults (so Meta re-delivers, safe because of the (teamId,channel,externalId) dedupe), keeps raw_payload, and adds a phone_number_id defense-in-depth check. The outbound webhook stack is excellent: BullMQ webhook:deliver queue with idempotent jobIds, exponential retry (4 attempts), circuit breaker counting deliveries (not attempts), per-team in-process fairness gate, SSRF-safe fetch with per-hop DNS re-resolution + redirect re-validation + sensitive-header stripping + bounded response read, HMAC signing with timestamp replay protection, an orphan-delivery sweeper to recover rows lost between create+enqueue, and the outbox pattern (publishInTx) to close the crash-between-commit-and-publish window. The external /v1 API has Bearer auth with timing-equalized rejection + per-IP negative-path throttle, scope guard, Stripe-style claim-then-execute idempotency, and a robust dual loop guard (X-CCP-Depth chain cap of 8 + X-CCP-Origin-Key server-side rejection). Loop safety is explicitly designed: broadcast/workflow sends use sibling event types excluded from the public allowlist, and webhook.* events are documented as forbidden from the subscribe list to prevent self-ping-pong. Findings below are genuinely minor — no Critical/High issues found; the dimension is production-ready for the pilot._

### ⚪ [Low] integrations-webhooks-1 — Orphan-delivery sweeper re-enqueues without chainDepth, weakening the cross-system loop guard for recovered deliveries

**Location:** apps/api/src/lib/sweepers/orphan-webhook-delivery.ts:99; apps/api/src/lib/outbound-webhooks/queue.ts:20-21

**Problem.** When the orphan-delivery sweeper recovers a delivery row that was created but never enqueued (Redis outage / process death between db.create and enqueueWebhookDelivery), it calls `enqueueWebhookDelivery(o.id)` with no chainDepth argument (orphan-webhook-delivery.ts:99). The original chainDepth captured by the subscriber lives only on the BullMQ job payload, never persisted on the OutboundWebhookDelivery row (queue.ts:20-21 comment: 'Rides on the job, not the delivery row, so no schema change'). So a recovered delivery POSTs the partner with X-CCP-Depth:1 (chainDepth 0 + 1) regardless of the true depth of the originating request.

**Why dangerous.** The X-CCP-Depth header is the cross-system loop brake — a partner that bounces our webhook back into /v1 relies on the depth incrementing toward MAX_CHAIN_DEPTH (8) to break the loop. A recovered orphan delivery resets that counter to 1, so if the originating event was already deep in a chain, the recovered hop under-counts. In a sustained loop this could let a few extra round-trips through before the cap engages.

**Impact.** Negligible at pilot scale: orphan recovery only fires on a Redis-outage/crash window (rare), AND the X-CCP-Origin-Key server-side loop guard in ApiKeyGuard (api-key.guard.ts:175-185) plus the per-conversation send budget and per-key 60/min limit independently break the loop. This is a defense-in-depth degradation, not an open loop. At growth it stays bounded by the same backstops.

**Fix.** Persist chainDepth on the OutboundWebhookDelivery row at create time (add a nullable `chainDepth Int` column, or stash it in the existing payload/correlation metadata) and have the orphan sweeper read it back into enqueueWebhookDelivery(o.id, row.chainDepth). Lowest-effort alternative: re-derive depth from the persisted payload if it ever carries an inbound depth marker. Given the multiple independent backstops, deferring is also defensible.

**Verifier evidence.** apps/api/src/lib/sweepers/orphan-webhook-delivery.ts:99; apps/api/src/lib/outbound-webhooks/queue.ts:14-22,105-116; apps/api/src/outbound-webhooks/outbound-webhooks.subscriber.ts:167,280,296; apps/api/src/lib/outbound-webhooks/worker.ts:216,411; apps/api/src/common/correlation.ts:92-96; apps/api/src/auth/api-key.guard.ts:157,175-185

### ⚪ [Low] integrations-webhooks-2 — Outbound webhook receiver gets no documented secret-rotation overlap; rotation instantly invalidates in-flight signature verification on the receiver

**Location:** apps/api/src/lib/outbound-webhooks/worker.ts:360-382; apps/api/src/lib/outbound-webhooks/signing.ts:18-22

**Problem.** deliverOnce reads webhook.secret fresh on every attempt and signs with the single current secret (worker.ts:362-382). There is one secret per OutboundWebhook row. If an operator rotates the webhook secret (via the team/outbound-webhooks settings), every delivery from that instant signs with the new secret, while the partner's receiver may still be configured with the old one — and there is no dual-secret / overlap window. The signing helper (signing.ts) and worker have no concept of a previous secret.

**Why dangerous.** During a secret rotation the partner's HMAC verification will fail for the cutover window until they update their stored secret, causing deliveries to bounce (which then count toward the circuit breaker and can auto-disable the webhook after 20 consecutive failed deliveries). It's a self-inflicted outage risk rather than a security hole.

**Impact.** At one pilot customer this is essentially theoretical — rotation is a rare, operator-initiated action and the partner coordinates it. Becomes a real operational papercut only at multi-tenant scale where partners rotate independently and a botched rotation silently trips the breaker.

**Fix.** When the trigger fires (multiple partners), add an optional `previousSecret` + `previousSecretExpiresAt` on OutboundWebhook and sign with both (emit two X-CCP-Signature values, e.g. `v1=<new>,v1=<old>`) during the overlap, mirroring Stripe's rolling-secret model. Not worth building now — note it as the rotation-UX trigger.

**Verifier evidence.** apps/api/src/lib/outbound-webhooks/worker.ts:362,382,70,637,64-68; apps/api/src/lib/outbound-webhooks/signing.ts:18-22 (single-secret HMAC, no previousSecret in OutboundWebhook model)
  _(verdict: partially_confirmed)_

### ⚪ [Low] integrations-webhooks-3 — POST /v1/contacts (create) ignores Idempotency-Key — a partner retry-after-timeout double-fires contact.created (and its webhook fan-out) unless the phone collides

**Location:** apps/api/src/external/v1/external-v1.controller.ts:221-231; apps/api/src/external/v1/external-v1.service.ts:326-330

**Problem.** Nearly every /v1 mutation threads an Idempotency-Key through the shared ApiIdempotencyService (assign, status, tag add/remove, contact update/upsert/delete, sends, notes). But the plain `POST /v1/contacts` create path takes no idempotencyKey: the controller only calls guardChainDepth (external-v1.controller.ts:223-231) and the service createContact(teamId, apiKeyId, input) has no idempotency parameter (external-v1.service.ts:326-330). A partner whose automation times out and retries the create will run the mutation twice.

**Why dangerous.** A double create re-publishes contact.created twice, fanning two outbound-webhook deliveries and two workflow 'On Contact created' triggers for what the partner intended as one logical create. The second insert is usually saved by the partial unique constraint Contact_teamId_phoneNumber_whatsapp_key (P2002 → error), so a true duplicate ROW is prevented — but the error surfaces as a 4xx/5xx to the partner on a retry that should have been a clean replay, and the upsert endpoint (which IS idempotent) is the documented happy path anyway.

**Impact.** Low at any scale because the phone unique constraint blocks the duplicate row; the cost is a confusing error on retry plus (in the rare race where both inserts land before the constraint bites) a redundant event. The idempotent `POST /v1/contacts/upsert` already covers the find-or-create need.

**Fix.** Accept `Idempotency-Key` on POST /v1/contacts and wrap createContact in the existing withIdempotency helper (already used by upsert and bulk-tags in the same service), fingerprinting on the normalized phone + fields. Cheap and consistent with the rest of the surface.

**Verifier evidence.** apps/api/src/external/v1/external-v1.controller.ts:221-231 (no idempotency-key); apps/api/src/external/v1/external-v1.service.ts:326-330 (no idempotencyKey param),469-498 (dual publish),814-828 (upsert uses withIdempotency),91 (withIdempotency helper)

### ⚪ [Low] integrations-webhooks-4 — Inbound Meta webhook has no payload-size ceiling distinct from the global 10mb body limit; a 10mb signed batch is parsed + fanned before any guard

**Location:** apps/api/src/webhooks/meta/meta.controller.ts:185-209; apps/api/src/lib/providers/ingest.ts:68-141

**Problem.** main.ts configures bodyParser.json with a 10mb limit (the rawBody capture hook). The Meta webhook controller verifies HMAC over rawBody then calls getMetaProvider().parseWebhook(payload) and ingestEvents over the full batch (meta.controller.ts:185-209). There is no per-webhook event-count or byte ceiling below the global 10mb — a single valid-HMAC payload could carry a very large entry[].changes[] array, which the ingest path then processes with INGEST_CONCURRENCY=8 serializable transactions plus a background media download per media event.

**Why dangerous.** Only the team holding the correct appSecret can produce a valid-HMAC payload (so this is not an unauthenticated DoS), and the WebhookRateLimitGuard caps 600 req/min/team. But within one accepted request the work is unbounded by event count: a pathological 10mb batch = thousands of events × serializable tx + Meta media fetches, which can saturate the Prisma pool and the 4-lane media downloader for the duration.

**Impact.** Effectively a non-issue at pilot scale — Meta batches are small (a handful of changes) and a tenant abusing its own number only harms itself, throttled at 600/min. Worth a cheap bound only if a tenant ever reports ingest stalls; the existing INGEST_CONCURRENCY cap already protects the pool from the parallel-explosion case.

**Fix.** If ever needed, add a sanity cap on events.length after parseWebhook (e.g. drop+log batches over a few hundred events as malformed) before ingest. Not required now; document as a scale-cliff note rather than fix.

**Verifier evidence.** apps/api/src/main.ts:150-151 (10mb); apps/api/src/webhooks/meta/meta.controller.ts:158,185-209,493; apps/api/src/lib/providers/ingest.ts:60-68 (INGEST_CONCURRENCY=8 + rationale); apps/api/src/webhooks/webhook-rate-limit.guard.ts:32 (600/min/team)
  _(verdict: partially_confirmed)_

---

## Database — Schema / Indexes / Queries / Multi-tenancy

_This is an exceptionally strong, production-grade database layer — among the best-engineered I've reviewed at this stage. The 40-model Prisma schema is well-normalized with deliberate, documented denormalization (Contact.lastInboundAt, Conversation counters/analytics, TeamChannelMessage thread counts) that eliminates per-open aggregates. Index coverage is comprehensive and matches actual query shapes: keyset composites for every list/thread path, trgm GIN for substring search (name/email/phone/preview/body), jsonb_path_ops for customFields, and a full set of hand-written partial indexes (inbound-only messages, drainer-pending, retention-complement, default-stage, WhatsApp phone unique) that the comments correctly explain Prisma's DSL can't express. The autovacuum-tuning migration (2026-06-01) is a level of operational maturity rarely seen at pilot stage. Multi-tenancy is rigorous: every by-id read/write I traced (messages, conversations, contacts, media, external-v1 partner API) is teamId-scoped via findFirst({id, teamId}) or proven-tenant ids upstream — I found NO cross-tenant leak. Transactions are correct: the inbound-ingest Serializable retry for the contact/conversation race, the second-tx P2002 catch with clean rollback, atomic {increment} counters, and predicate-gated updateMany for first-writer-wins analytics. The transactional outbox + per-team-fair drainer (FOR UPDATE SKIP LOCKED + ROW_NUMBER windowing) is excellent. The only items below are low-severity scalability notes, every one of which is already explicitly documented in the schema/code with a stated trigger — they are NOT bugs and bite nothing at pilot scale. I am reporting them at their true low severity rather than inflating._

### ⚪ [Low] database-1 — messageCount/noteCount COUNT(*) aggregate runs on every thread open and reconnect

**Location:** apps/api/src/lib/queries/conversations.ts:324 (consumed at apps/web/src/features/inbox/components/contact-panel.tsx:204)

**Problem.** getConversationWithRefs (apps/api/src/lib/queries/conversations.ts:324) includes `_count: { select: { messages: true, notes: true } }`, issuing COUNT(*) WHERE conversationId=? on the Message and InternalNote tables on EVERY thread hydration (SSR open, client-side chat-switch cache-miss, and the full-refetch on socket reconnect — all hot paths per CLAUDE.md). Because of the one-conversation-per-contact invariant (closed threads reopen, never fragment), a single long-lived contact's thread can accumulate a very large message count over months/years. The COUNT is consumed only to render a 'Messages: N' / 'Notes: N' stat in the contact panel (contact-panel.tsx:204).

**Why dangerous.** A COUNT(*) over a growing single-conversation partition gets slower as that thread's history grows; at the reconnect-refetch frequency this adds DB load proportional to the busiest threads' lifetime size.

**Impact.** Negligible at pilot scale (threads have hundreds, not millions, of rows; COUNT rides the (conversationId, timestamp) btree as an index range scan, and the new autovacuum tuning keeps the visibility map fresh enough for index-only scans). Becomes a few-ms cost per open only on the heaviest multi-year threads. Not a current-scale problem.

**Fix.** Optional, only if EXPLAIN ever shows it hot: drop the live COUNT from the hot hydration and either (a) render the stat from the loaded `messages.length` + a 'and N more' affordance, or (b) maintain a denormalized `messageCount`/`noteCount` on Conversation bumped in the same tx as message/note insert (the analytics counters already do exactly this pattern for incoming/outgoing). Today's index-backed COUNT is fine — do not pre-optimize.

**Verifier evidence.** apps/api/src/lib/queries/conversations.ts:324 (+320-324 comment, 342-343 consumption); callers conversations.service.ts:167 and apps/web/src/app/(app)/inbox/page.tsx; consumed at contact-panel.tsx:203-208; index schema.prisma:911; denorm precedent schema.prisma:791-794

### ⚪ [Low] database-2 — mediaCaption is searched in global Messages search but has no trgm index (body-only)

**Location:** apps/api/src/lib/queries/global-search.ts:164-165; documented at prisma/schema.prisma:923-927

**Problem.** The team-wide Messages search (apps/api/src/lib/queries/global-search.ts:164) filters `OR: [{ body: { contains } }, { mediaCaption: { contains } }]`, but only `Message.body` carries a trgm GIN index (Message_body_trgm_idx). The `mediaCaption` ILIKE arm has no supporting index, so for a media-caption-only match the planner cannot use the trgm path and falls back toward a scan of the team's message partition for that OR arm. The schema comment at prisma/schema.prisma:923-927 explicitly acknowledges this and defers it ('Add a mediaCaption trgm index if caption search shows up hot in EXPLAIN').

**Why dangerous.** As the Message table grows, a search whose term only matches in captions could degrade that OR arm to a larger scan than the body arm.

**Impact.** None at pilot scale — captions are stored in `mediaCaption`, but the common search match is in `body` (which IS indexed), and the result set is bounded by `take`. This is a documented, deliberate deferral with a clear EXPLAIN-driven trigger, not a defect.

**Fix.** If caption search ever shows up hot: add `@@index([mediaCaption(ops: raw("gin_trgm_ops"))], type: Gin)` (or a partial WHERE mediaCaption IS NOT NULL hand-written index, matching the existing partial-index pattern). Leave as-is until then.

**Verifier evidence.** global-search.ts:163-166; index schema.prisma:928; deferral comment schema.prisma:923-927; caption-duplicated-into-body at ingest.ts:572+583 and :714+717, messages.service.ts:1400+1419 (send) and :1857+1877 (forward)
  _(verdict: partially_confirmed)_

### ⚪ [Low] database-4 — Stale OutboundEvent retention schema comment claims sweeper 'not wired yet' — contradicts the live sweeper

**Location:** prisma/schema.prisma:1952-1954 (comment) vs apps/api/src/lib/sweepers/outbound-event-retention.ts:30 (7-day RETENTION_MS) + apps/api/src/workflows/workflow-worker.service.ts:211 (wiring)

**Problem.** The OutboundEvent model comment in prisma/schema.prisma:1952-1954 reads: 'Retention: published rows accumulate indefinitely for forensic queries. A cleanup sweep should DELETE rows where publishedAt < NOW() - INTERVAL 30 days once the table gets large; not wired yet (no scale pressure).' This is factually wrong as of current code: apps/api/src/lib/sweepers/outbound-event-retention.ts already implements and the WorkflowWorkerService already starts (line 211) a daily retention sweeper that deletes published, non-failed rows older than 7 days. The comment also states a 30-day cutoff while the implemented sweeper uses 7 days (RETENTION_MS at outbound-event-retention.ts:30).

**Why dangerous.** Documentation that says a critical retention job is missing actively misleads future audits (it just generated a false-positive 'unbounded growth' finding) and risks a developer either re-implementing the sweeper redundantly or, worse, raising mem/disk alarms believing the outbox is growing forever. The cutoff mismatch (7d code vs 30d comment) could also drive an operator to expect 30 days of forensic history that the sweeper has already deleted.

**Impact.** No runtime impact — the table IS bounded correctly. Pure correctness-of-documentation defect. Cost is wasted audit/dev cycles and one already-materialized false-positive review finding.

**Fix.** Update the schema.prisma:1952-1954 comment to state the sweeper exists (apps/api/src/lib/sweepers/outbound-event-retention.ts, started in WorkflowWorkerService), uses a 7-day cutoff matching OutboundEvent_retention_idx, and keeps failedAt-NOT-NULL rows for operator triage. Optionally reconcile the documented cutoff (7d) anywhere else it's referenced.


---

## API Layer — Controllers / Validation / Authz / Idempotency

_This is one of the most thoroughly-engineered API layers I have audited. Across all 34 controllers the shape is uniform: class-level `SessionGuard` (or `@RequireRole`/`@RequireScope`), `zBody`/`zQuery` Zod validation on every body/query, teamId taken from `session.teamId`/`auth.teamId` (never client-supplied), and mutations gated by `@RequireCapability` or an inline `resolvePermissions(...)` boolean passed to a framework-agnostic service. I specifically traced IDOR risk through to the service layer on the highest-risk paths (external /v1 contact/tag/conversation mutations, message forward, conversation assign, media serving, admin-teams) and every one scopes by teamId in the WHERE clause and gate-then-mutate (findFirst{id,teamId} → update{id, version} CAS). The external /v1 surface is excellent — per-route `@RequireScope`, Stripe-style `Idempotency-Key`, `X-CCP-Depth` cross-system loop guard, per-key + per-unauth-IP rate buckets, and a browser-Origin refusal in main.ts. Security depth is unusual for pilot stage: timing-safe HMAC on the Meta webhook with phone_number_id defense-in-depth and fail-soft 200s; a complete SSRF guard (DNS re-resolution per redirect hop, IMDS/RFC1918/ULA blocking, sensitive-header stripping, bounded body reads) on every customer-configured-URL path; boot-time FATAL checks for dev-tools and the SSRF escape hatch in prod; `zRolePermissions` is `.strict()` and `resolvePermissions` force-grants admin/superAdmin so the permission matrix can't be used to escalate or self-lock; slowloris timeouts + 10MB body cap; `take` clamped via Zod or Math.min everywhere I checked. The Prisma exception filter maps codes to correct statuses and keeps `.meta` (which can carry PII) server-side only. I found NO Critical or High issues — no missing authz, no IDOR, no mass-assignment, no scope bypass, no validation gaps. The items below are minor/observational only._

### ⚪ [Low] api-1 — Per-handler rate-limit buckets keyed by perMinute let a user multiply effective quota across same-bucket routes when limits differ

**Location:** apps/api/src/common/rate-limit.interceptor.ts:73, :109; messages.controller.ts:46-49

**Problem.** RateLimitInterceptor keys buckets as `${principal}:${perMinute}` (rate-limit.interceptor.ts:73,109). The design comment on MessagesController (messages.controller.ts:46-49) states text+media+template+forward 'count against one bucket so a user shouldn't be able to multiply quota by hitting different routes' — and that holds, because all four share the class-level `@RateLimit({ perMinute: 60 })`, so they map to the same `u:<id>:60` bucket. However the keying-by-perMinute means any two routes a user can call that happen to carry DIFFERENT perMinute values get INDEPENDENT buckets. This is correct and intentional for isolating a hot read endpoint from mutation budget, but it also means the global 300/min default bucket (`u:<id>:300`) is entirely separate from the 60/min send bucket (`u:<id>:60`): a user at the send cap still has a full 300/min for every other mutation. That is the intended behavior, not a bug — flagging only so the invariant ('one user can't multiply quota') is understood to hold ONLY within a single perMinute value, not globally.

**Why dangerous.** Not dangerous at pilot scale. A malicious authenticated user is still bounded to 60/min on the cost-bearing Meta send path (the only path with real external/billing impact); other routes are cheap DB reads/writes already bounded by the 300/min default and the 600/min per-IP middleware. There is no path to exceed the Meta-facing cap.

**Impact.** None at current scale. Worth a one-line code comment so a future dev adding a second cost-bearing route remembers to put it on the SAME @RateLimit value as the existing send bucket rather than relying on the global default.

**Fix.** No code change required. Optionally add a comment near DEFAULT_PER_MIN noting that cost-bearing routes must share an explicit @RateLimit value to share a bucket; the per-perMinute keying is otherwise the correct isolation strategy.

**Verifier evidence.** apps/api/src/common/rate-limit.interceptor.ts:109 (key=`${principal}:${perMinute}`), :73-74 (comment); messages.controller.ts:49 (class @RateLimit 60); calls.controller.ts:66 (also 60, shares bucket); messages.schemas.ts:110 (MAX_FORWARD_TOTAL=40)

---

## Performance — Frontend Renders + Backend Hotpaths + Queries

_This dimension is genuinely excellent — among the most carefully performance-engineered codebases I've audited at pilot stage. The frontend hot components (inbox-shell, message-thread, contact-panel, conversation-list, conversation-list-item) are all memoized with hand-tuned custom comparators; identity-stable callbacks via refs prevent the classic "every keystroke re-renders 500 bubbles" trap; day-separator labels are precomputed once per timeline (not per bubble); `message:status` ticks are RAF-coalesced; typing is coalesced to one socket emit per session; the conversation list IS virtualized (@tanstack/react-virtual). The backend is equally strong: the inbox list query uses keyset pagination + lean explicit selects + a denormalized `Contact.lastInboundAt` (killing the old per-page lateral MAX scan); thread hydration replaced two `count()` queries with one `_count` aggregate; activity-event actor names resolve in one batched lookup (no N+1); the session guard has a cookie-hash cache that short-circuits Better Auth's DB lookups under reconnect storms; ingest uses bounded concurrency (8 lanes) to protect the Prisma pool; realtime fanout is meticulously room-scoped so broadcasts and status ticks never team-storm; all search paths ride trgm GIN + keyset indexes. The findings below are real but minor and mostly scale-gated — none bite at current pilot scale, and several are already documented as deliberate deferrals with explicit revisit triggers. The dominant risk on this dimension is over-tinkering with already-correct code._

### ⚪ [Low] performance-1 — Tabbed inbox search fires 3 parallel team-wide ILIKE queries on every (debounced) keystroke

**Location:** apps/web/src/features/inbox/components/inbox-search-panel.tsx:63-65; apps/web/src/features/inbox/hooks/use-inbox-search.ts:69-97

**Problem.** InboxSearchPanel mounts three useInboxSearch hooks simultaneously — one each for the contacts / messages / notes scopes (inbox-search-panel.tsx:63-65). Each hook independently debounces 250ms and then fires its own GET /api/inbox/search?scope=... (use-inbox-search.ts:78-92). So a single search session issues 3 concurrent server queries (contact trgm, message trgm, note trgm) even though the agent is looking at only one tab. The two backgrounded scopes are fetched purely to make tab-switching feel instant.

**Why dangerous.** It triples the per-search DB load for a feature whose result the user mostly never looks at (only one tab is visible at a time). The message-scope query in particular does a team-wide `body OR mediaCaption` ILIKE; the mediaCaption branch has no trgm index, so at large message volume the wasted background query is the most expensive of the three.

**Impact.** Negligible at pilot scale — trgm GIN keeps each query in single-digit ms over a few thousand rows, and AbortController cancels stale in-flight requests on each keystroke. Becomes a measurable 3x search-load multiplier only at high message/contact volume (tens of thousands of rows) with multiple agents searching concurrently.

**Fix.** Lazy the two inactive scopes: only fire the active tab's query immediately, and fetch the other two scopes on first switch to them (or on a short idle after the active query lands). Keep the already-fetched results cached so a second switch stays instant. This preserves the instant-tab-switch UX after the first visit while removing the always-3x cost on the common single-tab search.

**Verifier evidence.** apps/web/src/features/inbox/components/inbox-search-panel.tsx:63-65,46-49; apps/web/src/features/inbox/hooks/use-inbox-search.ts:69-97; apps/api/src/conversations/inbox-search.controller.ts:42-49
  _(verdict: partially_confirmed)_

### ⚪ [Low] performance-2 — Inbox-list filter-change + reconnect resync rebuild the entire conversations array, re-rendering all virtualized rows

**Location:** apps/web/src/features/team-chat/hooks/use-team-events.ts:291-313, 410-423

**Problem.** On a server-side filter change, the resync handler maps the authoritative page into a brand-new array reference and reconciles it against local rows (use-team-events.ts:291-313), and resyncOnce does the same on every reconnect (use-team-events.ts:392-423). Both produce all-new ConversationWithRefs objects from the fetched page, so even rows whose visible content is unchanged get a fresh object reference. ConversationListItem's memo comparator (conversation-list-item.tsx:163-176) does field-level scalar comparison, so most rows still bail out of re-render — but the per-event splice handlers (onAssigned/onStatus/onContactUpdated) preserve references for untouched rows, while these two full-rebuild paths do not.

**Why dangerous.** On a filter switch or reconnect with a large loaded slice (100-250 rows after several load-more pages), every row object is replaced. The per-item memo still prevents the actual DOM re-render for unchanged rows (good), but each row's comparator runs the full field-by-field check, and the virtualizer re-derives. It's bounded work, just not as cheap as the reference-preserving splice paths elsewhere in the same hook.

**Impact.** Not noticeable at pilot scale (small lists, infrequent filter switches/reconnects). The memo comparator absorbs the cost so there's no visible jank. Only matters as a CPU micro-cost on very large lists during a reconnect storm; virtualization already caps the rendered set to viewport + overscan.

**Fix.** In the filter-change and resyncOnce reconcile maps, return the existing local object reference when its scalar fields match the server row (the same field set the item memo compares), rather than always spreading a fresh object. This lets React's own reconciliation short-circuit before the per-item comparator even runs. Low priority — the existing memo already prevents the expensive part.

**Verifier evidence.** apps/web/src/features/team-chat/hooks/use-team-events.ts:291-313,392-423,558-591; apps/web/src/features/inbox/components/conversation-list-item.tsx:163-176
  _(verdict: partially_confirmed)_

### ⚪ [Low] performance-3 — Team-wide global message search ORs an un-indexed mediaCaption column with the trgm-indexed body

**Location:** apps/api/src/lib/queries/global-search.ts:163-182; prisma/schema.prisma:920-928

**Problem.** searchAllMessages filters `WHERE teamId AND (body ILIKE %q% OR mediaCaption ILIKE %q%)` (global-search.ts:163-182). Only `body` has a trgm GIN index (Message_body_trgm_idx); mediaCaption has none (confirmed in schema.prisma:920-928 and the init migration — the schema comment explicitly notes 'Add a mediaCaption trgm index if caption search shows up hot in EXPLAIN'). Postgres can satisfy the body branch via the GIN index but the mediaCaption OR-branch forces the planner to also consider a heap scan; for a broad/short query term the planner may fall back to a sequential scan over the team's messages, bounded only by teamId.

**Why dangerous.** It's a latent seq-scan vector on the largest table in the system (Message). At pilot volume it's invisible. As one tenant's message history grows into the hundreds of thousands, a global search on a common 3-char fragment could scan a large fraction of that tenant's messages, spiking a request handler's DB time and pinning a pool connection.

**Impact.** No impact now (few thousand messages, single-digit ms). The Message_teamId_timestamp_id_idx already backs the ORDER BY + LIMIT for broad terms, which mitigates the sort cost; the remaining risk is the filter scan from the un-indexed caption branch. Scale-gated; the code already names the exact EXPLAIN-based trigger to fix it.

**Fix.** When the tenant's Message count grows (the documented trigger), add `CREATE INDEX Message_mediaCaption_trgm_idx ON Message USING gin (mediaCaption gin_trgm_ops) WHERE mediaCaption IS NOT NULL` so the OR-branch is also index-backed. No action needed at current scale — this is a Low note flagging the documented future cliff, not a present bug.

**Verifier evidence.** apps/api/src/lib/queries/global-search.ts:163-182; prisma/schema.prisma:919-928,936; prisma/migrations/0_init/migration.sql:879 (only body trgm); grep confirms no Message_mediaCaption index in any migration

---

## Authentication & Session

_This is one of the most carefully-engineered parts of the codebase. The auth/session model is sound and the recurring historical bug classes (ERR_TOO_MANY_REDIRECTS, random logouts, stale-role survival, deactivation lag) are all genuinely closed in current code. DB-backed sessions are the single source of truth; the web (Better Auth, cookie issuance) and NestJS (validate-only guard + two-tier 15s cookie/userId cache) sides share one config from packages/shared so a cookie issued by one validates on the other, with the same secret wired to both containers in compose. Privilege transitions (role change, deactivation, deletion, password change, team deletion, permissions-matrix edit) all delete Session rows AND call invalidateSessionCache/revoke, closing the cache-survival window; the socket handshake re-runs auth on every reconnect and converges to deactivation state. Capability resolution (resolvePermissions + @RequireCapability + RoleGuard) is pure, defaults preserve pre-feature behavior, admin/superAdmin can't be locked out, and the persisted matrix is Zod-validated to reject admin/superAdmin keys. Lockout is now DB-persisted (survives restart) with a true atomic increment. CSRF is defended by SameSite=Lax cookies plus a strict CORS origin allowlist (preflight blocks cross-origin JSON), the /logout route additionally has a Sec-Fetch-Site guard, and the internal session-invalidation RPC is timing-safe-compared AND blocked at the Caddy edge. Findings are minor: a login timing oracle enabling email enumeration, an inaccurate security claim in the proxy comment, and a defense-in-depth note on CSRF posture. No Critical or High issues found._

### ⚪ [Low] auth-session-1 — Login response-time oracle enables email enumeration despite identical error messages

**Location:** apps/web/src/lib/auth/index.ts:56-93 (the `if (!user)` and `if (user.deactivatedAt)` early returns at 71-80 skip the bcrypt path at 82-86)

**Problem.** signInWithCredentials returns early for a non-existent email after only a DB lookup + one LoginAttempt upsert (no bcrypt), but for an EXISTING email with a wrong password it proceeds into auth.api.signInEmail which runs bcrypt.compare (~100ms at cost 10). The user-facing error string is identical ('Invalid email or password.'), but the ~100ms latency difference is a reliable side channel: an attacker can distinguish 'this email has an account' from 'this email does not' by timing the response. The deactivated-user branch also short-circuits before bcrypt, leaking a third timing class (account exists but disabled).

**Why dangerous.** Email enumeration on a B2B SaaS lets an attacker build a list of valid tenant accounts to target with password-spray or phishing. The per-account lockout and the identical error text are explicitly designed to defeat enumeration, but the timing channel bypasses both protections.

**Impact.** Low at pilot scale: the proxy already caps /login at 5 req/min/IP, which slows but does not eliminate enumeration (an attacker with a few IPs can still confirm a target list over time). B2B work emails are often guessable anyway, so the marginal leak is modest. Grows mildly with user base.

**Fix.** Equalize the work across all failure branches: always perform a bcrypt verify against a fixed dummy hash when the user is missing or deactivated (a constant-cost decoy compare), so every wrong-credential path spends ~the same CPU before returning the generic error. Compute the dummy hash once at module load. This is the standard 'dummy hash' enumeration mitigation and keeps the existing generic-message + lockout logic intact.

**Verifier evidence.** apps/web/src/lib/auth/index.ts:71-74 (no-bcrypt missing-user path), :76-80 (no-bcrypt deactivated path), :82-86 (bcrypt path); packages/shared/src/auth/password-policy.ts:18 (BCRYPT_COST=10); apps/web/src/app/login/actions.ts:26-29 (no equalizing delay)

### ⚪ [Low] auth-session-2 — Proxy comment claims forged cookies 'fail parse' but getSessionCookie does presence-only check (no signature verify)

**Location:** apps/web/src/proxy.ts:21-24 and :321-323 (claims) vs. better-auth getSessionCookie at node_modules/.pnpm/better-auth@1.6.11_.../better-auth/dist/cookies/index.mjs:169-178

**Problem.** proxy.ts line ~22-24 states: 'Better Auth signs the session cookie, so a forged cookie fails parse here (getSessionCookie returns null).' In better-auth@1.6.11, getSessionCookie (node_modules/.../cookies/index.mjs:169-178) only checks for the PRESENCE of the cookie value and returns the raw string — it performs no HMAC/signature verification. A request carrying `ccp.session_token=garbage` therefore yields hasCookie=true and is forwarded to the route handler rather than bounced to /login.

**Why dangerous.** Not an actual security hole — the route handlers (getSession for pages, SessionGuard for API) do the authoritative DB lookup and reject the forged value, exactly as the rest of the same comment says. The risk is purely that a future maintainer trusts the inaccurate claim and, e.g., relaxes a downstream check believing the edge already validated the signature.

**Impact.** No runtime impact today; authoritative validation is correctly delegated to the handlers. Purely a correctness-of-documentation / future-footgun concern.

**Fix.** Fix the comment to state the truth: getSessionCookie is a presence check, not a signature check; a forged-but-present cookie is intentionally allowed through the edge and rejected by the handler's DB lookup. This matches the (correct) 'cheap at the edge, authoritative in the handler' division already described two sentences later.

**Verifier evidence.** node_modules/.pnpm/better-auth@1.6.11_.../better-auth/dist/cookies/index.mjs:169-178 (presence-only check, no signature verify); apps/web/src/proxy.ts:19-20 and :321-323 (inaccurate claims); apps/api/src/auth/session.guard.ts:265-308 (authoritative DB validation that actually rejects forged cookies)

### ⚪ [Low] auth-session-3 — CSRF on the ~120 cookie-authenticated NestJS mutations relies solely on SameSite=Lax (no token, no Origin/Sec-Fetch assertion on the API)

**Location:** apps/api/src/main.ts:206-296 (only /v1 has an origin check; enableCors is the sole cross-origin gate); apps/api/src/auth/session.guard.ts (no Origin/Sec-Fetch check); contrast apps/web/src/app/logout/route.ts:60-63

**Problem.** Every session-cookie mutation on NestJS (77 @Post / 25 @Delete / 20 @Patch / 1 @Put) is protected against cross-site CSRF only by the cookie's SameSite=Lax attribute. There is no CSRF token, and no global Origin or Sec-Fetch-Site assertion on the API for cookie-auth routes (the only Sec-Fetch-Site check lives in the Next.js /logout route; the only Origin check is the /v1 browser-refusal). The /logout handler explicitly notes 'a CSRF token isn't strictly necessary here because the owned cookies are SameSite=Lax' — the same single layer is the whole defense for the rest of the API.

**Why dangerous.** SameSite=Lax does correctly block the classic cross-site form/XHR POST (the browser omits the cookie), and for application/json bodies the strict CORS origin allowlist forces a preflight that a cross-origin attacker fails — so in practice the combined posture is adequate. The residual gap is the SameSite=Lax blind spots: top-level GET navigations carry the cookie (no GET mutations exist today, but a future @Get side effect would be exposed), and 'same-site' requests from a sibling subdomain are not blocked by Lax — relevant only if a subdomain is ever added or compromised.

**Impact.** No exploitable path at current single-domain pilot scale (verified: zero GET-mutating endpoints; JSON content-type triggers protective preflight; cross-site POST drops the cookie). Becomes a real concern if the app ever adds an untrusted/user-content subdomain on the same registrable domain, or if a future endpoint performs a state change on GET.

**Fix.** Keep SameSite=Lax, but add a cheap defense-in-depth assertion as a global NestJS middleware/guard for cookie-authenticated mutations: reject when Sec-Fetch-Site is 'cross-site' (mirroring the /logout guard), or require an Origin matching APP_PUBLIC_URL on non-GET cookie-auth requests. This makes the CSRF posture two-layer and immune to the Lax sibling-subdomain edge before any subdomain is added. Document the GET-must-be-side-effect-free invariant alongside it.

**Verifier evidence.** packages/shared/src/auth/better-auth-config.ts:138-142 (sameSite lax, sole CSRF layer); apps/api/src/main.ts:280-296 (prod CORS pinned to single APP_PUBLIC_URL — forces preflight, blocks cross-origin JSON); apps/api/src/main.ts:206-236 (only Origin check is /v1); apps/api/src/auth/session.guard.ts (no Origin/Sec-Fetch check); apps/web/src/app/logout/route.ts:60-63 (the lone Sec-Fetch-Site guard); 0 GET-mutating endpoints verified across 72 @Get handlers
  _(verdict: partially_confirmed)_

---

## Error Handling & Reliability

_Strong posture; minor findings only._

### 🟡 [Medium] reliability-1 — analytics-drift sweeper bypasses the shared sweeper mutex

**Location:** apps/api/src/lib/sweepers/conversation-analytics-drift.ts:42-48,80-105; _mutex.ts:25-57

**Problem.** Heaviest full-Message-table UPDATE runs without withSweeperMutex, concurrent with contact-drift, doubling pool pressure.

**Why dangerous.** Both hold pool slots under 30s statement_timeout; pool starvation at scale.

**Impact.** No bite now; at 100k+ messages it starves the pool once per day.

**Fix.** Wrap sweepOnce in withSweeperMutex and add it to the SweeperName union.

**Verifier evidence.** apps/api/src/lib/sweepers/conversation-analytics-drift.ts:38-48 (runTick calls sweepOnce bare, no mutex), :80-105 (full-Message aggregate UPDATE via $executeRaw); apps/api/src/lib/sweepers/_mutex.ts:25-34 (SweeperName union omits it); apps/api/src/lib/sweepers/contact-last-inbound-drift.ts:40 (sibling uses withSweeperMutex); apps/api/src/workflows/workflow-worker.service.ts:162 (started alongside contact-drift at 151)

### ⚪ [Low] reliability-2 — Web process has no global unhandled-rejection net

**Location:** apps/web/instrumentation.ts:15-20; apps/api/src/main.ts:51-56

**Problem.** api has log-and-continue rejection handlers; web standalone has none, so Node 24 terminates on unhandled rejection.

**Why dangerous.** A future un-caught background promise hard-crashes the web container.

**Impact.** Zero today; missing guardrail vs the api.

**Fix.** Add process.on rejection handlers in apps/web/instrumentation.ts.

**Verifier evidence.** apps/web/instrumentation.ts:15-20 (register() does only validateEnv, no process handlers); grep of apps/web/src for uncaughtException/unhandledRejection returns nothing outside .next cache; apps/api/src/main.ts:51-56 (api has both handlers); apps/web/Dockerfile FROM node:24-slim
  _(verdict: partially_confirmed)_

### ⚪ [Low] reliability-3 — emitProgress void publish without .catch

**Location:** apps/api/src/lib/broadcast-runner.ts:1300; outbound-webhooks/worker.ts:665

**Problem.** broadcast-runner.ts:1300 omits the .catch the bus convention uses; publish never rejects in practice.

**Why dangerous.** Style inconsistency relying on the api process net.

**Impact.** None today.

**Fix.** Append a .catch console.error at broadcast-runner.ts:1300.

**Verifier evidence.** apps/api/src/lib/broadcast-runner.ts:1299-1308 (void publish, no .catch); apps/api/src/lib/outbound-webhooks/worker.ts:665-674 (sibling void publish WITH .catch); apps/api/src/lib/events/bus.ts:168-203 (publish swallows outbox error internally, never re-throws)

### ⚪ [Low] reliability-4 — outbound-webhook-delivery-cleanup sweeper also bypasses the shared mutex

**Location:** apps/api/src/lib/sweepers/outbound-webhook-delivery-cleanup.ts:39-49 (bare sweepOnce, no mutex), :75-86 (deleteMany); :8-11 (own 'millions of rows' estimate); apps/api/src/lib/sweepers/_mutex.ts:25-34 (union omits it)

**Problem.** outbound-webhook-delivery-cleanup.ts is a second non-hot-path daily sweeper that runs its deleteMany outside withSweeperMutex (runTick calls sweepOnce() bare, line 43). Like conversation-analytics-drift it is missing from the SweeperName union, so the shared mutex — which the _mutex.ts header doc claims serializes '14+ sweepers' — actually covers neither. The delete is a single indexed `createdAt < cutoff` deleteMany, lighter than the analytics aggregate, but the file's OWN comment estimates the table can reach 'millions of rows over a year' (10k events/mo x N webhooks x 4 retries), and a first-run 30-day-cutoff delete over a multi-million-row table is a long-running write holding a pool slot. It starts in the worker init block too (10min initial delay), so under restart-realignment it can overlap the unguarded analytics-drift sweep — exactly the dogpile the mutex exists to prevent.

**Why dangerous.** Two of the three intended-to-be-serialized daily sweepers run concurrently and unbounded against the same 50-slot Prisma pool under the 30s statement_timeout; combined with finding reliability-1, the mutex's pool-starvation guarantee is void for the heaviest writers. Latent at one customer; real once OutboundWebhookDelivery grows large.

**Impact.** No bite at pilot scale (table is small, deletes are fast). At sustained webhook volume the daily backlog-delete can run long and, aligned with the unguarded analytics aggregate, double pool pressure once per day — the precise failure mode the mutex was written for.

**Fix.** Add "outbound-webhook-delivery-cleanup" to the SweeperName union in _mutex.ts and wrap its sweepOnce in withSweeperMutex("outbound-webhook-delivery-cleanup", sweepOnce) — same one-line change as the fix for reliability-1. (orphan-webhook-delivery.ts at 60s cadence is arguably hot-path-exempt like inbound-media, so it can stay unwrapped or be added to the exempt rationale in the doc.)


---

## Contacts / Conversations / Pipeline (stages, tags, fields, filters, search, bulk, broadcasts)

_This dimension is genuinely strong — among the most carefully-engineered areas of the codebase. The hard correctness problems are already solved and verified in current code: contact dedupe via a partial phone unique with Serializable-retry on P2002/P2034 (ingest.ts:451-538), soft-delete-then-revive across all four create paths (manual/CSV/inbound/v1), optimistic-concurrency `version` CAS on every contact write, the stage-filter re-sync race (contact-browser.tsx:352-396 with filter-aware in-place patch/drop/refetch and a `reqId` generation guard on loadMore + refetch), bulk-tag coalescing (one `contact.bulk_updated` frame instead of N), broadcast per-team fairness (both broadcast-level AND recipient-level slot gates), and the broadcast double-send guard via OutboundSendAttempt claim→complete→flip ordering with a boot reconciler. Conversation assign/status side-effects live in one shared mutations.ts so UI/workflow/API can't drift, with correct CAS and cause→effect event ordering. The conversation-counts hook handles the optimistic-stage-flicker settling window precisely. Search rides real trgm GIN indexes (name/phone/email/message-body/note-body). Findings below are bounded edge cases and one missing-index perf note — none are pilot-blocking, and several are explicitly-documented tradeoffs I am NOT flagging as bugs (broadcast reopen not audited/workflow-triggered; broadcast message:new scoped to conversation room; bulk-delete per-contact events; mid-fetch crash double-send window). The single most important risk here is over-tinkering with already-correct convergence logic._

### ⚪ [Low] contacts-pipeline-1 — Tag delete does not invalidate audience-group membership/count caches or notify the broadcast wizard

**Location:** apps/api/src/team/tags/tags.service.ts:102-108

**Problem.** TagsService.remove (tags.service.ts:102-108) deletes the Tag, cascading the implicit _ContactToTag and _AudienceGroupToTag join rows away, then publishes team.catalog_changed{scope:"tags"}. It does NOT publish scope:"audience-groups". An audience group composed by that tag silently loses members. Any open broadcast-wizard / audience-group settings tab that derived a live recipient count from that tag keeps showing the stale higher count until a manual refresh, because the audience-groups consumers listen for scope:"audience-groups", not scope:"tags".

**Why dangerous.** An operator could look at a 'send to 400 recipients' count that was inflated by a since-deleted tag, then send fewer than they believe (or, conversely, be confused about the drop). The membership resolution itself (resolveAudienceGroupMembers / countAudienceContacts) is always recomputed server-side at broadcast create time, so the ACTUAL send is correct — this is a stale-display-count problem, not a wrong-send problem.

**Impact.** Cosmetic at current pilot scale (one customer, tags deleted rarely). No data loss, no wrong send. Becomes mildly more visible as teams build more tag-based audience groups.

**Fix.** In TagsService.remove, after computing whether any AudienceGroup referenced the tag (a cheap `audienceGroup.count({ where: { teamId, tags: { some: { id } } } })`), also publish team.catalog_changed{scope:"audience-groups"} so the group form + wizard refetch. Cheapest correct version: always publish the audience-groups scope alongside the tags scope on tag delete.

**Verifier evidence.** apps/web/src/hooks/use-audience-count.ts:30-63 (re-fetch only on tagKey/contactKey); apps/web/src/hooks/use-catalog-sync.ts:54-73 (tags NOT affinity-filtered → already refreshes /broadcasts); apps/api/src/lib/queries/audience-groups.ts:180-198 (server count drops deleted tag id); apps/web/src/features/audience-groups/components/group-form.tsx:54-57
  _(verdict: partially_confirmed)_

### ⚪ [Low] contacts-pipeline-2 — Global contact search ORDER BY createdAt cannot ride the trgm GIN match index — sorts the whole match set

**Location:** apps/api/src/lib/queries/global-search.ts:62-143

**Problem.** searchContacts (global-search.ts:62-143) filters with a trgm-backed ILIKE OR (name/phone/email) but then orders by `[createdAt desc, id desc]` with a keyset cursor on createdAt. A GIN trgm index satisfies the filter, but it carries no ordering, so Postgres must collect every matching row and sort by createdAt before applying LIMIT. For a broad query term that matches a large fraction of a big tenant's contacts, this degrades to a full match-set materialize+sort per page.

**Why dangerous.** Not dangerous now — at pilot scale (one tenant, thousands of contacts) the match set is tiny and the sort is sub-ms. The risk is purely a latency cliff that appears only at large contact volume with broad search terms.

**Impact.** No impact at current scale. At ~50k+ contacts AND broad search terms, the global-search Contacts tab gets slow. The team-wide message/note search has the same shape and the migration 20260530140000 comment already acknowledges this exact pattern as accepted.

**Fix.** No action needed now — it's a documented scaling cliff class. If it ever bites: either keep the trgm filter but cap broad terms with a tighter LIMIT + secondary scan, or add a composite GIN+btree strategy. Listed only so it's a conscious deferral, not a surprise.

**Verifier evidence.** apps/api/src/lib/queries/global-search.ts:95 (orderBy createdAt desc, id desc); prisma/migrations/0_init/migration.sql:827-847 (all Contact indexes — no teamId+createdAt composite); prisma/migrations/20260530140000_search_sort_and_retention_indexes/migration.sql:29-33 (Message/InternalNote got the composite; Contact did not)

### ⚪ [Low] contacts-pipeline-3 — CSV import counts an intra-file duplicate of a TOMBSTONED phone as both revived-and-skipped inconsistently vs created path

**Location:** apps/api/src/contacts/contacts.service.ts:1052-1123, 1222-1234

**Problem.** importCsv splits pending rows into toCreate / toRevive / skipped by phone state (contacts.service.ts:1008-1012). The created-path math correctly absorbs intra-file duplicate NEW phones into skippedExisting via `skippedExisting + (toCreate.length - created)` (line 1228). But the toRevive loop (1052-1123) handles an intra-file duplicate of the same tombstoned phone by letting the SECOND occurrence CAS-miss (flip.count===0 → continue) WITHOUT adding it to any counter. So a file with the same soft-deleted phone twice reports `revived: 1` and silently drops the second row from every tally — it is neither in `revived`, `created`, `skippedExisting`, nor `errors`. The reported `total` (parsed.rows.length) then won't equal created+revived+skippedExisting+errors.length for that file.

**Why dangerous.** Purely a reporting/reconciliation discrepancy in the import-result summary the UI shows ('X new, Y restored, Z skipped'). The DB end state is correct (one revived contact). No data loss, no double-link (the pair-builder de-dupes by contactId:tagId).

**Impact.** Negligible — duplicate phones within a single uploaded file are rare, and only matters for the tombstoned subset. The summary numbers just won't sum to total in that narrow case.

**Fix.** Pre-dedupe `pending` by phoneNumber before the activeSet/tombstoned split (keep first occurrence, count the rest into skippedExisting), mirroring how the created path's count math already absorbs them. One de-dupe pass fixes the toRevive branch symmetrically with toCreate.

**Verifier evidence.** apps/api/src/contacts/contacts.service.ts:1011 (both dups land in toRevive), :1083-1087 (count===0 continue, no tally), :1012 (skippedExisting=activeSet.size excludes tombstoned), :1228 (create path absorbs dups, revive path does not), :1223 (total=parsed.rows.length)

### ⚪ [Low] contacts-pipeline-4 — CSV import with duplicate header columns silently keeps only the last column's values

**Location:** apps/api/src/contacts/contacts.service.ts:834-844; apps/api/src/lib/csv.ts:80-96

**Problem.** parseCsv intentionally hands back raw header arrays and builds per-row objects keyed by trimmed header (csv.ts:80-96); on a duplicate header name the row object's `obj[key]` is last-write-wins, and importCsv's `headerMap = new Map(parsed.headers.map(h => [h, classify(h)]))` (contacts.service.ts:834) collapses duplicates to one classification. So a CSV that (e.g. from a sloppy export merge) has two 'tags' or two 'email' columns silently reads only the rightmost one, with no warning surfaced to the operator.

**Why dangerous.** Silent partial data loss on import for a malformed-but-plausible file. The operator believes both columns imported. Bounded to genuinely malformed input — well-formed exports (including this app's own export path) never produce duplicate headers.

**Impact.** Low at pilot scale; the app's own export round-trips cleanly, so this only bites hand-assembled or third-party-merged CSVs. No crash, no cross-tenant issue.

**Fix.** When building unknownColumns/headerMap, detect a header that appears more than once in parsed.headers and add it to a new `duplicateColumns` field on ImportResult so the UI can warn 'column X appeared twice — only the last was used'. Detection is one `headers` frequency pass; no behavior change needed beyond the warning.

**Verifier evidence.** apps/api/src/lib/csv.ts:82-89 (obj[key]=cell last-write-wins); apps/api/src/contacts/contacts.service.ts:834 (Map collapses dup headers); apps/api/src/contacts/contacts.service.ts:46-64 (ImportResult has no duplicateColumns warning field)

---

## Code Quality — Dead Code / Duplication / Abstractions / Hidden Side Effects

_This codebase is unusually clean for a solo-dev pilot project, and most generic "dead code" suspicions do not hold up. I verified ZERO orphan files in apps/api/src/lib (the one candidate, avatar.ts, is imported via a relative path), ZERO orphan web components, ZERO commented-out code blocks, only 3 TODO markers (all legitimate), and a fully-completed NestJS migration cleanup (no lingering `.provider` row-field reads, dead Next.js API routes exactly match the documented intentional set, legacy webhook proxy has a clear not-yet-passed 2026-06-19 deletion deadline). The dev module is correctly gated with three layers of defense. The large "god files" (messages.service.ts 2285, external-v1.service.ts 1654, step-editors.tsx 1513, contact-panel.tsx 1545) are large-but-cohesive, not kitchen-sinks. The genuine issues are all DUPLICATION: (1) an incomplete consolidation that left 4 byte-for-byte copies of `normalizeCustomFields` despite a `normalizeStringMap` helper explicitly created to kill exactly this drift; (2) the outbound "commit + monotonicity-guard" transaction block copy-pasted across 6 send paths (with one variant already drifted); (3) hand-rolled Contact DTO construction in ~12 sites that bypass the canonical `mapContact` mapper and have already drifted (omitting `callPermissionRevokedUntil`). Plus a handful of genuinely dead exports in packages/shared. None are Critical; the duplications are the real maintenance/correctness risk because they have already started to diverge._

### 🟡 [Medium] code-quality-1 — Four byte-for-byte copies of `normalizeCustomFields` despite a canonical helper created to kill exactly this drift

**Location:** apps/api/src/lib/external-shapes.ts:258, apps/api/src/lib/workflows/events.ts:417, apps/api/src/lib/queries/_shared.ts:206, apps/api/src/lib/providers/ingest.ts:1200 (canonical: apps/api/src/lib/normalize-string-map.ts:6)

**Problem.** `apps/api/src/lib/normalize-string-map.ts` exports `normalizeStringMap`, whose own doc comment states it is the 'Canonical home for normalizeStringMap, which had drifted into 7 byte-for-byte copies.' That consolidation was INCOMPLETE: there are still 4 byte-for-byte-identical copies of the same function under the alias `normalizeCustomFields` — apps/api/src/lib/external-shapes.ts:258, apps/api/src/lib/workflows/events.ts:417, apps/api/src/lib/queries/_shared.ts:206, apps/api/src/lib/providers/ingest.ts:1200. All four have the identical body (`if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}; ...for...if typeof v === 'string'`) — confirmed identical char-for-char to normalizeStringMap.

**Why dangerous.** The whole point of the SSOT helper was to prevent the coercion contract (drop non-string values, drop arrays/non-objects) from diverging across the contact-customFields read sites. With 5 copies of the same logic, a future change to the coercion rule (e.g. start coercing numbers to strings, or stop silently dropping nested objects) must be applied in 5 places or the customFields shape silently differs between the inbox read, the workflow event snapshot, the external-v1 wire shape, and the ingest path.

**Impact.** No runtime bug today (all copies are identical). Pure latent-divergence + cleanup. The risk materializes the next time anyone touches custom-field coercion semantics — a partner could see a customFields key on the /v1 API that the inbox dropped, or vice versa.

**Fix.** Delete all 4 `normalizeCustomFields` local definitions and import `normalizeStringMap` from `@/lib/normalize-string-map` at each site (it's already imported in some files, e.g. external-v1.service.ts). Optionally re-export it as `normalizeCustomFields` from _shared.ts if call-site naming churn is a concern, but a single underlying impl is the goal.

**Verifier evidence.** apps/api/src/lib/normalize-string-map.ts:1-13; apps/api/src/lib/external-shapes.ts:258-265; apps/api/src/lib/workflows/events.ts:417-424; apps/api/src/lib/queries/_shared.ts:206-213 (also consumed at queries/contacts.ts:222); apps/api/src/lib/providers/ingest.ts:1200-1207

### 🟡 [Medium] code-quality-2 — Outbound 'commit + timestamp-monotonicity-guard' transaction block copy-pasted across 6 send paths, with one variant already drifted

**Location:** apps/api/src/messages/messages.service.ts:150-172 (and 1390, ~1938), apps/api/src/lib/messaging/send-text-internal.ts:218-251, apps/api/src/lib/messaging/send-template-internal.ts:268-310, apps/api/src/lib/messaging/send-interactive-internal.ts:215-245

**Problem.** The post-send commit idiom — open a $transaction, read `{lastMessageAt, unreadCount}`, compute `effectiveBump = current.lastMessageAt >= messageTimestamp ? new Date(current.lastMessageAt.getTime()+1) : messageTimestamp`, update conversation preview+lastMessageAt, then `publishInTx` the `message.sent` event with that unreadCount — is duplicated near-verbatim in: messages.service.ts `commitOutboundEvent` (150-172), send-text-internal.ts (218-251), send-template-internal.ts (268-310), send-interactive-internal.ts (215-245). The PRE-tx monotonicity guard (`lastTs && lastTs >= receivedAt ? new Date(lastTs.getTime()+1) : receivedAt`) is additionally inlined in the media path (messages.service.ts:1390) and forward path (~1938). The send-interactive variant has ALREADY drifted: it guards `current.lastMessageAt && current.lastMessageAt >= ...` (null-check) while text/template use `current.lastMessageAt >= ...` (no null-check). The comments themselves admit the copy: 'same fix as send-text-internal.ts' / 'same idiom as sendTextInternal' appears 4+ times.

**Why dangerous.** This is the load-bearing correctness primitive that keeps inbox sort order monotonic and keeps the outbox/realtime emit atomic with the conversation bump (the doc comments explain past bugs: lost message.sent on crash, doubled partner POSTs, regressed conversation clock under race). Six copies means the next fix to this race has six places to land; the interactive-variant null-check drift is direct evidence the copies are already diverging. A subtle fix applied to 5 of 6 sites reintroduces the exact race the pattern exists to prevent.

**Impact.** No active bug at pilot scale, but it is the highest-consequence duplication in the repo because the logic is correctness-critical and concurrency-sensitive. Bites when a future maintainer adjusts the bump/publish semantics and misses a copy — manifests as out-of-order bubbles or a lost/doubled message.sent.

**Fix.** Extract one helper, e.g. `commitOutboundSend(tx-or-db, { conversationId, messageTimestamp, preview, eventBase })` that performs the read → effectiveBump → update → publishInTx in a single transaction and returns the effectiveBump. Have commitOutboundEvent + all three send-*-internal.ts + the media/forward paths call it. Pick the null-safe `current.lastMessageAt &&` form as the single implementation.

**Verifier evidence.** apps/api/src/messages/messages.service.ts:150-172 (full tx), 1390-1393 + 1939-1942 (guard-only); apps/api/src/lib/messaging/send-text-internal.ts:220-252 (no null-check at :232); send-template-internal.ts:274-307 (no null-check at :286); send-interactive-internal.ts:215-245 (HAS null-check at :227 — the drift)

### ⚪ [Low] code-quality-3 — Hand-rolled Contact DTO construction in ~12 sites bypasses canonical `mapContact` and has already drifted (omits callPermissionRevokedUntil)

**Location:** apps/api/src/contacts/contacts.service.ts:194, :277, :418 (vs canonical apps/api/src/lib/queries/_shared.ts:121-145); parallel hand-builds in apps/api/src/external/v1/external-v1.service.ts:512-578

**Problem.** There is a canonical `mapContact(c): Contact` mapper in apps/api/src/lib/queries/_shared.ts:121 that produces the full wire Contact (including `callPermissionRevokedUntil`). But contacts.service.ts and external-v1.service.ts inline-build the Contact/ExternalContact object literal by hand instead of calling it — 6 inline `phoneNumber: updated.phoneNumber`-style blocks in each file (e.g. contacts.service.ts:194, :277, :418; external-v1.service.ts revive at :512). The inline builds in contacts.service.ts (lines 194/277/418) do NOT set `callPermissionRevokedUntil`, while the canonical mapContact DOES — confirmed drift. Field is optional on the Contact type (types.ts:105) so it typechecks, but the `contact.created`/`contact.updated` events emitted from create/revive carry a Contact missing that field.

**Why dangerous.** Every new Contact field added to the type + mapContact has to be remembered in ~12 hand-rolled literals or it silently vanishes from create/revive event payloads — which is exactly what already happened with callPermissionRevokedUntil. Subscribers (workflow-dispatch, outbound-webhooks, socket reducers) receive a structurally-inconsistent Contact depending on which code path produced it.

**Impact.** Benign right now (a brand-new/revived contact has no call-permission revocation, so the missing field reads as absent rather than wrong). But it is concrete evidence the hand-rolled path drifts from the mapper. Future fields (or making callPermissionRevokedUntil meaningful on revive) will be dropped from these paths.

**Fix.** Replace the hand-rolled Contact literals in contacts.service.ts (create/revive/update result builds) with `mapContact(row)` (re-fetch or include the needed relations so the row matches PrismaContact). For external-v1, route through the existing `toExternalContact`/`contactRowToExternal` mapper consistently. Where tagIds aren't on the base mapper, spread `{ ...mapContact(row), tagIds }`.

**Verifier evidence.** apps/api/src/contacts/contacts.service.ts:194-213, :277-296, :418-437 (no callPermissionRevokedUntil); canonical apps/api/src/lib/queries/_shared.ts:121-145 (:135 sets it); apps/api/src/external/v1/external-v1.service.ts:556-575; type doc apps/api/src/../packages/shared/src/types.ts:102-105; only consumers calls.service.ts:120, inbox-shell.tsx:1009 read from fresh load
  _(verdict: partially_confirmed)_

### ⚪ [Low] code-quality-4 — `reviveSoftDeletedByPhone` duplicated between ContactsService and ExternalV1Service, with a source/event inconsistency

**Location:** apps/api/src/contacts/contacts.service.ts:236-307 vs apps/api/src/external/v1/external-v1.service.ts:512-610

**Problem.** The soft-delete revival mechanism — `db.contact.findFirst({ where: { teamId, phoneNumber, deletedAt: { not: null } } })` then `db.contact.update` with the same field set (`source:'manual'`, `deletedAt:null`, `version:{increment:1}`) and publish `contact.created` — is duplicated as a private method in both apps/api/src/contacts/contacts.service.ts:236 and apps/api/src/external/v1/external-v1.service.ts:512. The non-obvious core (the `deletedAt: { not: null }` find + the exact revival update shape) is identical. There's also a minor inconsistency in the external copy: it writes `source: 'manual'` to the row but publishes `contact.created` with `source: 'api'`.

**Why dangerous.** The revival update field-set is the kind of thing that MUST stay in lockstep (if a new column needs resetting on revive, both copies must be edited). The two have already diverged in actor wiring (userId vs apiKeyId) and event tail (external fires an extra contact.updated), and the source label is inconsistent between the persisted row and the emitted event.

**Impact.** Low-to-Medium: revive is a real path (re-chatting a hard-deleted contact). Bounded today, but the divergence trend means a future column added to the revive reset will likely be applied to only one path.

**Fix.** Extract the shared core (find soft-deleted by phone + the revival update returning the updated row) into one helper that both services call; keep the actor-specific event publishing in each caller. Fix the external copy to publish `source: 'manual'` (matching what it actually persists) or persist `source: 'api'` — make row and event agree.

**Verifier evidence.** apps/api/src/contacts/contacts.service.ts:252-256 (find) + :258-275 (update) + :298-304 (publish, source:'manual'); apps/api/src/external/v1/external-v1.service.ts:529-533 (find) + :535-553 (update, source:'manual' at :547) + :577-584 (publish contact.created with source:'api' at :581) + :586-604 (extra contact.updated)

### ⚪ [Low] code-quality-5 — Dead exports in packages/shared (unused convenience helpers + a leftover type alias)

**Location:** packages/shared/src/presence.ts:60; packages/shared/src/auth/permissions.ts:49,89,239; packages/shared/src/api-keys/scopes.ts:64; packages/shared/src/outbound-webhooks/public-events.ts:73; packages/shared/src/events/types.ts:961; packages/shared/src/types.ts:562

**Problem.** Several exported symbols in packages/shared are referenced nowhere outside their own declaration (verified by whole-repo grep): `isVisiblyOnline` (presence.ts:60 — its doc claims it's the SSOT for the appear-offline filter, but realtime.gateway.ts:264-272 inlines `r.availabilityStatus === 'offline'` instead, so the helper is dead AND its SSOT claim is false), `canGrantSuperAdmin` (auth/permissions.ts:49), `hasCapability` (permissions.ts:239 — the live path is `resolvePermissions`), `ALL_ROLES` (permissions.ts:89), `normalizeScopes` (api-keys/scopes.ts:64), `isPublicEventType` (outbound-webhooks/public-events.ts:73), `EventProvider` (events/types.ts:961 — a thin `type EventProvider = Channel` alias never consumed), and `ContactPatch` (types.ts:562 — a fully dead interface).

**Why dangerous.** Not dangerous — pure cleanup. The minor real concern is `isVisiblyOnline`: its comment asserts 'same rule everywhere this matters' implying it's the single source of truth for the appear-offline visibility filter, but the actual fanout (buildVisibleOnlineSnapshot) hand-inlines the rule. So the dead helper actively misleads — a maintainer 'fixing' offline visibility there would have no effect on the real filter.

**Impact.** Negligible at any scale. Dead-weight in the shared package; the isVisiblyOnline doc-vs-reality gap is a small future-confusion trap.

**Fix.** Delete the unused exports (ContactPatch, EventProvider, canGrantSuperAdmin, hasCapability, ALL_ROLES, normalizeScopes, isPublicEventType). For isVisiblyOnline: either route buildVisibleOnlineSnapshot through it (making the SSOT claim true) or delete it and correct the comment. Note: do NOT delete WINDOW_DURATION_MS, SESSION_MAX_AGE_S/UPDATE_AGE_S, DEFAULT_CAPABILITIES, MentionTrigger, QuickReaction — those are used internally and were false positives.

**Verifier evidence.** packages/shared/src/presence.ts:60-64 (dead; SSOT claim contradicted by apps/api/src/realtime/realtime.gateway.ts:271-273); packages/shared/src/auth/permissions.ts:49, :89, :239; packages/shared/src/api-keys/scopes.ts:64; packages/shared/src/outbound-webhooks/public-events.ts:73; packages/shared/src/events/types.ts:961; packages/shared/src/types.ts:562 — each grep-confirmed single-reference

### ⚪ [Low] code-quality-6 — `ContactPanelImpl` is a single ~1300-line component (manageable, not a kitchen-sink, but maintenance-heavy)

**Location:** apps/web/src/features/inbox/components/contact-panel.tsx:134-1434

**Problem.** apps/web/src/features/inbox/components/contact-panel.tsx is 1545 lines, of which a single component `ContactPanelImpl` spans lines 134-1434 (~1300 lines). Unlike step-editors.tsx (which is ~20 cohesive sibling editors) this is one monolithic function component handling all contact-panel concerns inline: identity header, every editable built-in field, custom fields, tags, stage, assignee, and the optimistic-save plumbing. It is cohesive (one feature) so not a true kitchen-sink, but it's the single largest component body in the web app.

**Why dangerous.** Not a bug. Large single-component bodies make the exhaustive-deps eslint-disable at line 218 harder to reason about (more closure surface), increase re-render blast radius, and raise the merge-conflict / regression surface for a solo dev editing it frequently.

**Impact.** Maintainability only — no runtime/perf issue at pilot scale (the component is already memoized via the Impl-wrapper pattern). Listed for completeness since the task asked whether the 1500-line files are cohesive; this one is the weakest on that axis but still defensible.

**Fix.** Optional: extract self-contained sub-sections (built-in field rows, custom-field section, tag/stage editors) into child components in a contact-panel/ subdir, mirroring how message-thread/ and contact-browser/ were already decomposed. Low priority — only worth doing when it next needs substantial edits.

**Verifier evidence.** apps/web/src/features/inbox/components/contact-panel.tsx: 1545 lines total; function ContactPanelImpl at :134, eslint-disable react-hooks/exhaustive-deps at :218, `export const ContactPanel = memo(ContactPanelImpl, …)` at :1376
  _(verdict: partially_confirmed)_

### ⚪ [Low] code-quality-7 — Two near-identical contact-row mappers in ingest.ts plus a third partial mapper, all using the local normalizeCustomFields

**Location:** apps/api/src/lib/providers/ingest.ts:1033-1055 (workflow snapshot) and :1180-1198 (Contact-ish mapper) both calling local normalizeCustomFields at :1200; vs canonical mappers _shared.ts:121 (mapContact) and workflows/events.ts:336 (workflowContactSnapshot)

**Problem.** apps/api/src/lib/providers/ingest.ts contains TWO separate contact-shaping functions that both map a Prisma-ish contact row to an object literal and both call the file-local normalizeCustomFields (the workflow snapshot at ingest.ts:1033-1055 and a second Contact-ish mapper at ingest.ts:1180-1198). Combined with workflowContactSnapshot living in workflows/events.ts:336 (which also has its own local normalizeCustomFields at events.ts:417) and the inbox mapContact in _shared.ts:121, the codebase has at least 4 distinct contact-to-DTO mappers, each independently spelling out the same scalar-field projection (id/phoneNumber/identityChannel/externalContactId/name/firstName/lastName/language/countryCode/email/location/customFields/source/createdAt). This is the structural root cause behind both code-quality-1 and code-quality-3: there is no single contact-projection SSOT, so coercion (normalizeCustomFields) and field-set (callPermissionRevokedUntil) both drift independently per mapper.

**Why dangerous.** Each mapper is a place a newly-added Contact column can be silently dropped, and each carries its own copy of the JSONB coercion. The drift is not hypothetical — it has already happened twice (the 4 normalizeCustomFields copies; the missing callPermissionRevokedUntil in the hand-rolled literals).

**Impact.** No runtime bug today. Pure maintainability/divergence — but it raises the cost and risk of every future Contact-field addition, because the field must be remembered in 4+ independent projections that the type system does not force to stay in sync (the DTO types are structural and tolerate missing optional fields).

**Fix.** Establish one contact-projection helper per output shape (domain Contact, WorkflowContactSnapshot, ExternalContact) and have every producer call it: mapContact for the domain Contact (already exists, extend with optional tagIds), workflowContactSnapshot for the snapshot (already exists — just remove the duplicate local normalizeCustomFields and import the canonical one), toExternalContact for the external shape (already exists). Delete the two inline mappers in ingest.ts in favor of these. This collapses code-quality-1, code-quality-3, and this finding into a single SSOT.


---

## Deployment & Production Infra

_This is one of the most carefully-engineered deployment setups I've reviewed at pilot stage — the bar here is unusually high. The Dockerfiles are correct multi-stage builds (standalone Next.js output, slim api image, non-root USER node, heap caps now correctly sized UNDER mem_limit, npm stripped, CVE overrides forced, healthchecks with start_interval). docker-compose mem_limits sum to ~6.75g on the 8g box with documented headroom, restart: unless-stopped is correct, stop_grace_period (100s api / 30s web) is tuned to the BullMQ drain budget, depends_on uses service_healthy gates, and the env wiring is comprehensive and matches validateEnv. The GHA pipeline is excellent: fail-fast secret validation, paths-filtered conditional builds, deep smoke test (parses /health JSON for db+redis reachability, not just HTTP 200), :previous retag rollback that PUSHES back to registry (avoiding the rollback-target-corruption trap), health budget sized to exceed migrate window, and a public-root probe that catches the "green /api/health but dark site" blind spot. Caddy routing order is correct (change-password before auth wildcard, /api/internal/* refused at edge, shallow web health probe decoupled from api liveness). The graceful-shutdown ordering in main.ts (server.close before app.close, bounded app.close budget) is textbook. Migrations correctly preserve the hand-written GIN/partial indexes the Prisma DSL can't express, with explicit "do not regenerate" guards. The real gaps are narrow and mostly recovery-related: no pre-migration backup combined with an auto-rollback that can't revert a forward-applied migration, a stale 4096 heap flag left in one package.json script, and a cron-dedup mismatch with the README. None of these break the happy path; they bite during incident recovery._

### 🟡 [Medium] deployment-1 — Auto-rollback swaps code images but cannot revert a forward-applied migration, and there is no pre-migration backup

**Location:** docker-compose.yml:409-414 (api CMD migrate-then-serve); .github/workflows/deploy.yml:754-804 (auto-rollback, no DB awareness); scripts/pg-backup.sh (only backup, runs nightly via cron at deploy.yml:597)

**Problem.** The api container runs `prisma migrate deploy` as the FIRST step of its CMD (docker-compose.yml:409-414), so the schema is migrated forward BEFORE the deploy.yml 'Wait for health' step (deploy.yml:646-686) ever runs. If a deploy ships a new migration that applies successfully but the new app code then crashes on boot or fails the health probe for any reason OTHER than the migrate timeout already handled, the 'Auto-rollback on health or ship failure' step (deploy.yml:754-804) retags `:previous-{web,api}` back to `:latest` and recreates the containers. Those `:previous` images carry the OLD code, which may be incompatible with the now-forward-migrated schema (e.g. a renamed/dropped column, a new NOT NULL the old code doesn't populate). The auto-rollback has no DB rollback path, and there is no pre-migration snapshot — the only restore point is the nightly 03:17 UTC pg_dump cron (scripts/pg-backup.sh), which can be up to ~24h stale.

**Why dangerous.** The safety net (auto-rollback) can produce a worse state than the failure it is reacting to: a running-but-schema-mismatched old image that 500s on every Prisma query, with the most recent recovery point potentially a full day old. The README explicitly says 'Database migrations do NOT auto-revert either way — fix forward', but the AUTOMATED rollback doesn't honor that — it blindly reverts images against a moved-forward schema.

**Impact.** At current pilot scale, schema changes are frequent (8 migrations in ~1 week) and the box has one customer, so a bad deploy here means total outage plus a manual restore from a possibly-stale dump. The deploy.yml:654-659 comment shows this exact class already caused one outage (the 60s→150s budget fix). The remaining hole is a migration that succeeds-then-crashes-the-app rather than times-out. Low-frequency but high-blast-radius.

**Fix.** Add a pre-migration `pg_dump` snapshot to the ship step BEFORE the api container recreates (the script already exists at /opt/ccp/pg-backup.sh — invoke it once at deploy start, tagging the file e.g. `pre-deploy-<sha>.sql.gz`). That guarantees a recovery point seconds before the migration, not up to 24h. Separately, gate destructive migrations: for any migration that drops/renames columns, follow the expand-contract pattern (additive deploy first, destructive change a deploy later) so `:previous` code stays schema-compatible and auto-rollback is actually safe. At minimum, document in the rollback runbook that auto-rollback after a migration requires a manual restore decision.

**Verifier evidence.** docker-compose.yml:413-414 (migrate-then-exec CMD); .github/workflows/deploy.yml:642 (ship recreates containers, applying migration); deploy.yml:652-692 (health step runs AFTER); deploy.yml:760-810 (auto-rollback, image+Caddyfile only, no DB path); deploy.yml:597-604 (only backup is nightly cron); scripts/pg-backup.sh:1-42 (no pre-deploy hook)

### ⚪ [Low] deployment-2 — api package.json `start` script still hard-codes --max-old-space-size=4096, contradicting the corrected Dockerfile heap cap

**Location:** apps/api/package.json:7

**Problem.** apps/api/package.json:7 still sets `NODE_OPTIONS='--max-old-space-size=4096 --conditions=react-server'` in the `start` script. The Dockerfile CMD (apps/api/Dockerfile:111) bypasses this by invoking `node` directly with ENV NODE_OPTIONS=2048 (apps/api/Dockerfile:81), so the PRODUCTION container is safe. But the `start` script's inline NODE_OPTIONS would OVERRIDE the env if ever used. The corresponding `dev` script (line 6) and both Dockerfiles were already corrected to 2048/1536, and CLAUDE.md's heap section explicitly forbids 4096 (it caused the cascading exited-137 OOM flakiness). This one script was missed in that sweep.

**Why dangerous.** It is a latent footgun. The api Dockerfile comments (lines 97-105) note the CMD WAS once `pnpm --filter @ccp/api start`; if anyone reverts to that chain, or runs `pnpm --filter @ccp/api start` to reproduce prod locally under a 3g cgroup, the 4096 inline NODE_OPTIONS wins and re-introduces the exact OOM-before-GC bug CLAUDE.md spent a whole section eliminating.

**Impact.** No effect on the current prod path (direct node CMD with 2048). Bites only if the CMD is reverted to the start script or someone uses the script under a memory-limited container. Zero impact at steady state today; a tripwire for a future regression.

**Fix.** Change apps/api/package.json:7 `--max-old-space-size=4096` to `2048` to match the Dockerfile, the dev script, and CLAUDE.md's rule. One-character-class edit; eliminates the only remaining live 4096 heap reference in the codebase.

**Verifier evidence.** apps/api/package.json:7 (start = 4096, confirmed); apps/api/package.json:6 (dev = 2048); apps/api/Dockerfile:81 (ENV 2048); apps/api/Dockerfile:111 (CMD bypasses start script); apps/web/package.json:9 (ALSO 4096 — disproves the 'only remaining' claim)
  _(verdict: partially_confirmed)_

### ⚪ [Low] deployment-3 — Nightly backup cron can be installed twice (deploy job vs README manual line use different dedup keys)

**Location:** .github/workflows/deploy.yml:597-598 (auto-install + dedup key); deploy/README.md:449-456 (stale manual instructions with divergent relative path)

**Problem.** The deploy job installs the backup cron idempotently by stripping any prior line matching `grep -Fv "/opt/ccp/pg-backup.sh"` then appending `17 3 * * * cd /opt/ccp && /opt/ccp/pg-backup.sh >> /opt/ccp/pg-backup.log 2>&1` (deploy.yml:597-598). The README's one-time setup instructs operators to add a DIFFERENT line: `17 3 * * * cd /opt/ccp && ./pg-backup.sh 2>&1 | logger -t ccp-backup` (deploy/README.md:455) which uses the RELATIVE path `./pg-backup.sh`. The deploy job's `grep -Fv` for the ABSOLUTE path `/opt/ccp/pg-backup.sh` will NOT match the README's relative line, so on any VPS where an operator followed the README before the auto-install shipped, BOTH cron entries persist and pg_dump runs twice nightly.

**Why dangerous.** Two concurrent pg_dump runs at 03:17 contend on the same postgres connection budget and write two ~identical files; the second can also trip the script's <10KB failure check race or double the I/O spike. More importantly, the README is now actively misleading — it documents a manual step the deploy job already automates, and the divergent command shape is what defeats the dedup.

**Impact.** Cosmetic-to-minor at pilot scale: duplicate backups waste disk (14-day retention doubles the count) and double the nightly I/O burst on the single VPS. No data loss. Only affects hosts where the README's manual line was added.

**Fix.** Either make the deploy-job dedup match both shapes (`grep -Fv 'pg-backup.sh'` without the leading path) OR delete the manual cron instructions from deploy/README.md:449-456 entirely and replace them with a note that the deploy job installs the cron automatically (which is the current truth). Aligning the README to the automated reality is the cleaner fix.

**Verifier evidence.** .github/workflows/deploy.yml:597-604 (absolute-path dedup + append); deploy/README.md:449-456 (relative-path `./pg-backup.sh` manual line that defeats the dedup)

### ⚪ [Low] deployment-4 — web image carries the post-pilot cli-tools TODO (prisma/pg/bcrypt CVE surface on the front-door image) — deferred, flagging the trigger

**Location:** apps/web/Dockerfile:97-144 (cli-tools stage) + :179-219 (copy + NODE_PATH); .github/workflows/deploy.yml:723-742 (seed exec targets `app`/web container)

**Problem.** The web (front-door) runtime image bundles a separate /opt/cli-tools node_modules with prisma@7.8.0, @prisma/client, @prisma/adapter-pg, pg, bcrypt, and tsx (apps/web/Dockerfile:117-144, copied at :183) purely so the deploy job's `docker exec app pnpm run db:seed:superadmin` step (deploy.yml:723-742) can run. The Dockerfile itself documents this as a post-pilot TODO (lines 104-115): relocate the seed exec target to the api container (which already has prisma/tsx) so the web image can drop this whole stage and ~80MB plus the prisma/pg/bcrypt CVE surface from the internet-facing image.

**Why dangerous.** The web container is the one Caddy routes `/`, `/_next/*`, and auth pages to — it is the most exposed surface. Shipping a native bcrypt binding + the full prisma CLI + pg driver on it widens the attack/CVE surface of the front door for a one-shot seed convenience. The CVE-override stub (picomatch/effect/esbuild forced versions at line 127) shows the team is already fighting CVE noise from exactly these deps.

**Impact.** No functional risk at pilot scale and the deps are explicitly pinned + CVE-overridden, so this is hygiene, not an active vulnerability. It is a documented deferral with a clear trigger (post-pilot ~2026-06-15). Listed at Low to confirm the trigger is real and the deferral is reasonable, not to push doing it now.

**Fix.** Per the Dockerfile's own TODO: after the pilot lands, switch the deploy.yml superadmin-seed step to exec into the `api` container (which has prisma + tsx via its full pnpm install) and delete the web image's cli-tools stage + the /opt/cli-tools PATH/NODE_PATH block. Net: smaller front-door image, narrower CVE surface. No change needed before the pilot.

**Verifier evidence.** apps/web/Dockerfile:117-144 (cli-tools stage with prisma/pg/bcrypt/tsx); apps/web/Dockerfile:183-184,219 (copy + PATH/NODE_PATH onto runtime image); apps/web/Dockerfile:104-115 (the team's own post-pilot TODO + trigger date); .github/workflows/deploy.yml:742-747 (seed exec targets the `app`/web container)

### ⚪ [Low] deployment-5 — web package.json `start` script also hard-codes --max-old-space-size=4096, the symmetric footgun the auditor's deployment-2 missed

**Location:** apps/web/package.json:9 (start = --max-old-space-size=4096); contradicted by apps/web/Dockerfile:209 (ENV 1536) and apps/web/Dockerfile:237 (CMD bypasses the script)

**Problem.** apps/web/package.json:9 sets `NODE_OPTIONS='--max-old-space-size=4096' next start` in the web `start` script — exactly the same 4096-vs-mem_limit mismatch deployment-2 flagged for the api, but on the web side. The web Dockerfile correctly sets ENV NODE_OPTIONS='--max-old-space-size=1536' (apps/web/Dockerfile:209, sized at 75% of the 2g web mem_limit) and the prod CMD invokes the standalone server directly via `node apps/web/server.js` (apps/web/Dockerfile:237), so the `start` script's 4096 is bypassed in the real prod container — same as the api case. But the script is a latent tripwire: `pnpm --filter @ccp/web start` (or the root `turbo run start` at package.json:12) under the 2g web cgroup would let V8 grow toward 4g while the cgroup OOM-kills at ~2g RSS before GC engages — the precise `exited (137)` cascade CLAUDE.md's heap section spent a whole section eliminating. The auditor explicitly claimed the api fix would leave 'the only remaining live 4096 heap reference' — this disproves that; there are two, and both should be corrected in the same sweep.

**Why dangerous.** Identical mechanism to deployment-2 but on the front-door web service: if anyone reproduces prod locally with `pnpm --filter @ccp/web start` / `turbo run start` under the compose web mem_limit (2g), or a future Dockerfile change reverts the CMD to the start script, the inline 4096 wins over the corrected 1536 ENV and re-introduces the OOM-before-GC bug. CLAUDE.md's heap rule ('--max-old-space-size ≤ ~75% of the service's compose mem_limit') is violated by both scripts; fixing only the api one leaves the rule half-enforced.

**Impact.** Zero impact on the current prod path (direct standalone-server CMD with ENV 1536). Bites only if the web service is launched via its npm/turbo `start` script under a memory-limited container. A tripwire for a future regression, exactly like deployment-2.

**Fix.** Change apps/web/package.json:9 `--max-old-space-size=4096` to `1536` to match the web Dockerfile ENV, the web dev script (3072 is the deliberate higher dev cap, fine), and CLAUDE.md's 75%-of-mem_limit rule. Do it in the same one-line sweep as the api fix in deployment-2 so the codebase has zero remaining 4096 heap references.


---

## Appendix A — verifier dismissals (diligence record)

These were raised by an auditor but **dismissed** on re-read — listed so you can see they were considered, not missed.

- **[false_positive]** (chat-load-switch) Conversation-list cursor goes stale after reconnect/visibility resync → gap on "Load older conversations" — The claimed silent-data-omission gap cannot occur. The cursor is keyset on (lastMessageAt, id) and lastMessageAt is STRICTLY MONOTONICALLY INCREASING — confirmed by commitOutboundEvent's effectiveBump = max(current+1, bumpTimestamp) (messages.service.ts:156-159) and the ingest path; a new message only ever moves a conversation UP. resyncOnce merges [freshPage1 (25 newest), ...tail] where tail = prev.filter(c => !freshIds.has(c.id)) (use-team-events.ts:416-422), so the OLD boundary row that the stale cursor points at is STILL in the displayed list (in the tail), unless it was itself bumped — in which case it's now in freshPage1 and still displayed. A subsequent loadMore fetches WHERE lastMessageAt < cursor (queries/conversations.ts:92-99), i.e. everything strictly older than the old boundary; any conversation that got bumped during the gap (and could be 'missing') has its lastMessageAt INCREASED past the cursor, so it lands in freshPage1, not below the cursor. No row older than the cursor is ever skipped — loadMore returns the full older page and dedupes already-present rows (use-team-events.ts:238-241). The actual (benign) effect of the stale cursor is a redundant re-fetch of the tail region that gets deduped, not omission. The finding's core mechanism ('skips every row between the refreshed head's tail and that stale cursor') is backwards: that region IS the displayed tail, fully present.
- **[false_positive]** (database) OutboundEvent has no retention sweep wired (only the index exists); table is grow-until-large by design — The core claim — 'no sweeper deletes from this table' / 'the remaining work is just the sweeper job' — is FALSE in current code. apps/api/src/lib/sweepers/outbound-event-retention.ts is a complete retention sweeper that runs `deleteMany` on `{ publishedAt: { not: null, lt: cutoff }, failedAt: null }` in bounded batches (sweepOnce, lines 75-100), keeping failedAt-NOT-NULL rows for forensics — exactly the policy the finding asks for, and exactly matching the OutboundEvent_retention_idx partial index (publishedAt NOT NULL AND failedAt NULL). It is WIRED into the lifecycle: started at workflow-worker.service.ts:211 (startOutboundEventRetentionSweeper) on a daily cadence and stopped on shutdown at :288. The finding also mischaracterizes the existing file as 'for the FAILED-row triage rule' — it is not; it deletes PUBLISHED rows. The only true artifact is documentation drift: the schema comment at schema.prisma:1952-1954 still says 'not wired yet (no scale pressure)', which is stale and directly produced this false positive. Cutoff is 7 days (sweeper) vs the comment's 30 — another doc/code mismatch, but the table is bounded.
- **[already_handled]** (api) Two team-catalog controllers enforce write-capability inline in the service rather than via @RequireCapability decorator (consistency, not a hole) — The capability gate is genuinely enforced, not skipped. StagesController.canManage (stages.controller.ts:47-49) and ContactFieldsController.canManage (contact-fields.controller.ts:47-51) resolve the capability from session.role + rolePermissions and thread it as a boolean into every mutating service call. Each service method calls requireManage(canManage) which throws ForbiddenException({error:'forbidden'}) when false: stages.service.ts:69/111/154/232 + the helper at :292-293; contact-fields.service.ts:83/111/182/219 + the helper at :310-311. I grepped for other callers — both services are exported by their modules but consumed ONLY by their own controllers (no service-to-service caller that could bypass the gate). So there is no current authz hole; this is purely a decorator-vs-inline consistency note as the finding states. The framework-agnostic-service rationale is also genuine (the boolean keeps the shared service free of Nest decorators).
- **[already_handled]** (api) CORS preflight (OPTIONS) bypasses guards + rate-limit interceptor — already documented as safe for current same-origin topology — Confirmed the exact code and mitigation. The NOTE at main.ts:272-279 documents that enableCors answers OPTIONS before the guard/interceptor chain, and the actual enableCors config (main.ts:280-296) pins origin to [APP_PUBLIC_URL] in production (falling to `false` if unset — NOT `true`/reflect-any), and to localhost:3000/127.0.0.1:3000 in dev. In the current single-domain Caddy topology web+api are same-origin so the browser never emits a cross-origin preflight, meaning the bypass path is unreachable at pilot scale. The risk is purely latent under a hypothetical future multi-subdomain deploy, which the in-code comment already flags with the exact trigger and fix. Correctly classified Low/latent; no action needed now.
- **[locked_decision]** (performance) Every visible inbound message fans the full Message object to the entire team room — This is an explicitly locked, heavily-documented design decision, and the finding itself says 'No change recommended now.' message.received/message.sent emit `message:new` via emitToTeam (fanout-rules.ts:70-101) — the fanout-rules header (lines 41-56) documents the emitToTeam-vs-emitToConversation decision tree, naming message:new (list ordering) as a correct emitToTeam case. CLAUDE.md 'Realtime cache patch matrix' and the room-scoping rules codify this. The rawPayload is already stripped before the wire (stripForWire, fanout-rules.ts:13-17,72). The genuine storm vectors (status ticks, media-ready, broadcast recipient sends, broadcast reopens) are ALL already scoped to the conversation room (fanout-rules.ts:116-123,145-152,297-306,317-323) — this team-wide path is bounded by genuine human/customer inbound cadence, exactly as the finding states. No present finding; a large-team future optimization (lean list frame) is at most a scaling-cliff note.
