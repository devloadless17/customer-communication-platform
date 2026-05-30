# Production Audit — 2026-05-30

_Method: 14 parallel dimension-finders → independent adversarial verifier per finding → synthesis. 88 findings claimed, 60 confirmed after refutation pass (32% refuted). 93 agents, ~7M tokens._

## Scores

| Axis | Score |
|---|---|
| Production Readiness | **82/100** |
| Architecture | **88/100** |
| Performance | **86/100** |
| Realtime | **87/100** |
| Database | **82/100** |
| Reliability | **83/100** |
| Security | **78/100** |
| Maintainability | **80/100** |

**Deploy confidence: `yes-with-caveats`**

> Codebase remains production-grade as the prior audits concluded — the chat, realtime, DB, and REST surfaces have zero Critical/High findings, and the Medium tier is dominated by latent-at-scale issues (drainer concurrency, search index gaps, broadcast nested-create) that don't bite at one pilot customer. But three findings cross the pilot-launch threshold and must land before flipping the switch: (1) the ask_question saveTo step writes a stale customFields snapshot on resume, silently wiping concurrent edits to other keys — pure customer-CRM data loss the moment any non-trivial timeoutHours is paired with manual edits, and the fix is a copy of the already-shipped update-field pattern; (2) CSV re-import after a delete silently no-ops instead of reviving, so the existing single-create revive contract is violated for the obvious \"refresh and re-upload\" pilot flow; (3) the session cookie-cache fast path returns a stale sessionId, inverting change-password's sign-out-other-devices semantics (signs out the requesting device, keeps the other one alive) for any user with 2+ active sessions — an everyday scenario. None of these are app-down or auth-bypass, so it's not a hard no, but they're cheap to fix and each is user-visible in the first pilot week. Once those three land, deploy with confidence; the rest is post-pilot backlog material.

## Severity breakdown

- Critical: 1
- High: 2
- Medium: 21
- Low: 36


---

# Critical (1)

## C1. ask_question saveTo overwrites concurrent customField edits from a stale envelope snapshot
_Workflows / automations / triggers_ · `apps/api/src/lib/workflows/steps/ask-question.ts:312-329`

**Problem.** When ask_question's `saveTo` config is set, the resume path writes the contact's customFields by spreading `c.customFields ?? {}` where `c = envelopeContact(envelope)`. The envelope was snapshot at dispatch time (potentially up to 7 days ago — MAX_TIMEOUT_HOURS=168). Any customField changes made by the user, /v1 API, other workflows, or other ask_question steps DURING the pause window are silently wiped because the write replays the stale snapshot's fields and only overwrites the one configured key.

**Why dangerous.** Customer data loss with no log trail. A long-pause ask_question ("what's your shipping address?" with 72h timeout) lands → during the wait the agent edits the contact's `phone_secondary` field via the UI → the reply arrives → ask_question writes the answer to `shipping_address` AND deletes `phone_secondary` because it was missing from the dispatch-time snapshot. The customer-facing CRM appears corrupt and the user has no idea which workflow nuked their edit.

**Impact.** Bites the moment ask_question is used with any timeoutHours > a few minutes AND another path edits customFields. With timeoutHours up to 7 days, this is the steady-state shape of the step. Every pilot using ask_question for survey-style flows on contacts that also get manual edits is exposed. Compare update_field.ts (line 100-105) which correctly reads a FRESH `db.contact.findFirst` row before merging.

**Fix.** Read the contact row fresh inside the saveTo block (same pattern as update-field.ts): `const fresh = await db.contact.findUnique({ where: { id: contactId, teamId: ctx.teamId }, select: { customFields: true, version: true } })`, then spread `normalizeStringMap(fresh.customFields)` as the base. Add the same `version`-based CAS that update-field uses so a concurrent edit surfaces as a conflict instead of silently winning the race.

**Verifier note.** Verified against the actual code:

1. `apps/api/src/lib/workflows/steps/ask-question.ts:312-329` matches the finding verbatim. The resume path does `const c = envelopeContact(envelope)` then `customFields: { ...((c.customFields ?? {}) as Record<string, string>), [config.saveTo.key]: trimmed }`. No fresh read of the contact.

2. `envelopeContact` (types.ts:180-185) reads from `envelope.data.contact`, populated from `run.eventPayload`. The runner builds the envelope once on resume via `buildEnvelope(wf.teamId, run.trigger, run.eventPayload)` (runner.ts:126) and never refreshes it. `workflowContactSnapshot` (events.ts:250-298) captures `customFields` at dispatch time.

3. `MAX_TIMEOUT_HOURS = 24 * 7` (ask-question.ts:114) — the snapshot can be up to 7 days stale by design.

4. The companion `update_field` step (update-field.ts:73-126) does the right thing: fresh `db.contact.findFirst` → spread `normalizeStringMap(contact.customFields)` → CAS on `version` → P2025 surfaces as `advanceWithError(409, "contact modified mid-step, retry the run")`. ask-question's saveTo block silently writes the stale snapshot back, wiping any keys mutated during the pause window — even though the code comment at lines 317-319 falsely claims "Same pattern as the manual contact-panel edit flow (update-field step + contact PATCH)".

5. Reachability is the steady-state shape of the feature: ask_question with `timeoutHours > a few minutes` + ANY concurrent customFields edit (UI PATCH on contact panel, /v1 contacts API, another workflow's update_field, another concurrent ask_question saveTo) loses the racing edit. Silent — no log, no error, no audit pill for the wiped keys.

6. Not in CLAUDE.md / MEMORY.md as intentional/locked/deferred. The post-MVP roadmap actively lists ask_question / automations depth as an in-flight workstream, and a relevant memory ("Workflow trigger-sender tokens") explicitly distinguishes "ORIGINAL trigger" data from current step targets — but does not address customFields freshness.

7. Severity = Critical is justified per the project's own severity guide ("data loss" → Critical). Blast radius is per-contact customer-CRM data with no recovery path and no log trail. The proposed fix is a copy of update-field.ts's already-shipped, already-tested pattern, so it cannot introduce a worse failure mode — it converts silent overwrite into a deterministic 409 that operators can retry.

Finding stands as written.



---

# High (2)

## H1. Cookie-cache fast path returns stale sessionId — change-password kicks the WRONG device out
_Auth / session / permissions_ · `apps/api/src/auth/session.guard.ts:152-161 (sessionCacheGetByCookie) and resolveSession's fast-path return at line 244`

**Problem.** sessionCacheGetByCookie() returns cacheGet(entry.userId), but the userId-keyed sessionCache stores a single ApiSession per user. With two browsers (cookie A → Session row A1, cookie B → Session row B1, both same userId), whichever cookie's slow path resolved last overwrites sessionCache[userId].sessionId. A subsequent request on cookie A then short-circuits via sessionCacheGetByCookie(hashA) and returns the snapshot whose sessionId is B1 (the other browser's row). The slow path explicitly re-binds sessionId on line 272 (`return { ...cached, sessionId }`) precisely to avoid this — but the cookie-cache fast path on line 244 returns `cached` unmodified.

**Why dangerous.** ChangePasswordController is the one and only consumer of session.sessionId: `await db.session.deleteMany({ where: { userId: session.userId, NOT: { id: session.sessionId } } })`. When the cookie-cache fast path serves a stale sessionId, change-password preserves the OTHER device's Session row and deletes the requesting browser's row. The user who just successfully verified their current password and entered a new one is signed out, while their other device stays alive. This is the inverse of the documented intent.

**Impact.** User-visible: change-password from device A surreptitiously logs device A out and keeps device B alive. Bites the moment any user has 2+ active sessions (mobile + desktop, two laptops, etc.) — extremely common. Also makes the 'change-password sign-out-other-devices' feature unreliable: the intended-to-survive device is the random one whose handshake hit the slow path most recently.

**Fix.** Either (a) store sessionId alongside userId in cookieCache (key by cookie-hash → { userId, sessionId, expiresAt }), and have sessionCacheGetByCookie re-bind sessionId on the returned snapshot, mirroring what line 272 already does for the userId-only cache path; or (b) drop the cookieCache entirely and just key on userId — the cookie-cache layer's only win is avoiding Better Auth's getSession call, but Better Auth itself already returns the correct sessionId. Option (a) is the smallest diff: change cookieCache entry to `{ userId, sessionId, expiresAt }` and make sessionCacheGetByCookie return `{ ...cacheGet(entry.userId), sessionId: entry.sessionId }`. Also update sessionCacheSetByCookie's signature to take sessionId.

**Verifier note.** Verified at apps/api/src/auth/session.guard.ts:152-161 and :272. The cookie-cache fast path returns `cacheGet(entry.userId)` unmodified, while the slow path at line 272 explicitly re-binds sessionId (`return { ...cached, sessionId }`) — the inline comment at 268-270 even calls out that the userId-keyed cache requires this rebinding. The fast path was missed. ChangePasswordController at apps/api/src/auth/change-password.controller.ts:145-147 does `deleteMany({ where: { userId, NOT: { id: session.sessionId } } })`, so a stale sessionId means the WRONG session row is preserved and the requesting browser is signed out. Reachable any time a user has two active browser sessions (both userIDs alive in cookieCache+sessionCache simultaneously, TTLs refreshed by traffic). Not flagged as intentional in CLAUDE.md or memory. Severity High is appropriate: change-password-sign-out-other-devices is a security-adjacent feature and the inverted semantics are user-visible and reproducible with two devices. Proposed fix (store sessionId in the cookieCache entry, rebind on return) mirrors the existing slow-path pattern and is minimally invasive.


## H2. CSV import silently no-ops on soft-deleted contacts instead of reviving
_Contacts / pipeline (stages/tags/filters/audience/broadcasts)_ · `apps/api/src/contacts/contacts.service.ts:965-972`

**Problem.** The CSV import pre-fetches `existing` phone numbers via `db.contact.findMany({ where: { teamId, phoneNumber: { in: ... } } })` without a `deletedAt` filter, so soft-deleted (tombstoned) contacts go into `existingSet` and their phones are excluded from `toCreate`. The user-visible result: re-importing a deleted contact silently counts as `skippedExisting`, the contact stays tombstoned and is NOT revived. The single-contact create path is correct (it calls `reviveSoftDeletedByPhone` on P2002), and the partial unique `Contact_teamId_phoneNumber_whatsapp_key` holds the slot — so the createMany's `skipDuplicates:true` would also have masked any silent failure. Two import sources of the same number now diverge in behavior.

**Why dangerous.** Pilot customers will hit this whenever they delete then re-import a contact (the obvious flow when a stale phone-list is re-uploaded). The contact stays invisible in the directory + a confused operator reports it as a broken import. The CSV round-trip rule in memory (project_contact_csv_tags_stage) is silently violated.

**Impact.** Every import after a deletion: deleted contacts stay tombstoned; agents lose access to them again with no error surfaced; conversations remain orphaned-from-directory. Hits any team that uses both manual delete + CSV re-import.

**Fix.** Two-step: (1) in `importCsv`, query `existing` with `deletedAt: null` so tombstoned rows aren't masked as duplicates; (2) before the `createMany`, look up `deletedAt: { not: null }` rows for those phones, run `updateMany({ data: { deletedAt: null, source: 'manual', ... } })` to revive them (same shape as `reviveSoftDeletedByPhone`), emit one `contact.created` per revived id, and count them as `created` (or a new `revived` counter on `ImportResult`). The createMany then handles only truly-new phones.

**Verifier note.** Verified independently against the code and schema.

1) Code matches at /home/aliubuntu/projects/loadless_projects/customer-communication-platform/apps/api/src/contacts/contacts.service.ts:965-972. `existing` is queried with `{ teamId, phoneNumber: { in } }` and NO `deletedAt` filter; tombstoned rows land in `existingSet`; `toCreate` excludes them; they're tallied as `skippedExisting` (line 1103). No revive path is wired into `importCsv`.

2) The partial unique `Contact_teamId_phoneNumber_whatsapp_key` (prisma/migrations/0_init/migration.sql:843) covers BOTH active and soft-deleted rows for WhatsApp — explicitly documented in schema.prisma:622-624 ("The partial unique covers BOTH active AND soft-deleted rows for WhatsApp ... the tombstoned row holds the WhatsApp phone slot"). So the slot IS held by deleted rows; the `findMany` correctly finds them, but the import then silently drops them on the floor instead of reviving. Even if the pre-filter were removed, `createMany({ skipDuplicates: true })` would still mask the failure.

3) Divergence with the single-create path is real. `createContact` catches P2002 (line 162) and calls `reviveSoftDeletedByPhone` (line 232) which clears `deletedAt`, overwrites directory fields, and republishes `contact.created`. CSV import has no equivalent — the same phone gets revived via the JSON API but stays tombstoned via CSV.

4) User-visible blast radius: directory reads filter `deletedAt: null` (e.g. line 1301, 1414), so a stuck-tombstoned contact stays invisible, conversations remain orphaned-from-directory, and the operator sees only an opaque `skippedExisting` count. The memory note `project_contact_csv_tags_stage` actively documents this CSV path and treats the round-trip as a supported flow; it does not carve out an exception for tombstoned rows. Not listed as intentional/locked/deferred in CLAUDE.md or memory.

5) Severity "High" is right: not data-loss / not a security hole (so not Critical), but it WILL bite within weeks of a pilot that combines manual delete + CSV re-upload (the obvious "I refreshed my list and re-uploaded" flow), and it silently violates the existing revive-on-re-add invariant the single-create path goes out of its way to maintain.

6) The proposed fix is sound and mirrors the existing `reviveSoftDeletedByPhone` shape: filter `existing` to `deletedAt: null`, run `updateMany` to clear `deletedAt` (+ overwrite source/fields) for tombstoned phones in the batch, emit `contact.created` per revived id, and count them in the response (either folded into `created` or a new `revived` counter). One nit on the fix: running the revive `updateMany` and the `createMany` in a single Serializable transaction would mirror the ingest race-backstop pattern, but the proposed plain sequence is acceptable for an admin-triggered import where concurrent ingest collisions are rare and the partial unique still prevents double-rows on collision.



---

# Medium (21)

## M1. @ccp/shared exports map omits actively used subpaths (presence, providers/calling-regions)
_Architecture_ · `packages/shared/package.json:8-32`

**Problem.** packages/shared/package.json's exports map does not list ./presence or ./providers/calling-regions, but apps/web/src/components/layouts/app-rail.tsx, availability-picker.tsx, inbox-sub-sidebar.tsx, features/inbox/components/contact-panel.tsx, message-thread/assignment-dropdown.tsx and apps/web/src/features/inbox/components/inbox-shell.tsx import them as static imports. The auto-memory entry 'shared_runtime_resolution' captures the situation: tsconfig paths bypass the package.json exports check at runtime, so static imports work — but dynamic import() of the same subpath throws ERR_PACKAGE_PATH_NOT_EXPORTED.

**Why dangerous.** Any change that converts one of these imports to dynamic (a code-splitting refactor on contact-panel.tsx, a lazy-loaded availability-picker, a Next.js bundler upgrade that tightens resolution, or moving the code into a server action that the bundler treats as a separate entry) breaks at runtime with no compile-time signal. The 'presence' feature shipped 2026-05-26 and is now load-bearing for inbox + the global app rail.

**Impact.** Latent breakage on any dynamic-import or bundler-tightening change; broken contract between package author and consumers.

**Fix.** Add the two missing entries to the exports map: "./presence": "./src/presence.ts" and "./providers/calling-regions": "./src/providers/calling-regions.ts". Optionally collapse to a wildcard like "./*": "./src/*.ts" to remove the maintenance burden of keeping the map in sync with src/ (a small policy change; everything in src/ is already meant to be public).

**Verifier note.** Confirmed by independent verification:

1. CODE MATCHES THE CLAIM. packages/shared/package.json:7-32 lists exports but does NOT include "./presence" or "./providers/calling-regions". Both files exist on disk (packages/shared/src/presence.ts, packages/shared/src/providers/calling-regions.ts) and are statically imported from many active (non-calls) places:
   - apps/web/src/components/layouts/app-rail.tsx (presence)
   - apps/web/src/components/layouts/availability-picker.tsx (presence)
   - apps/web/src/components/layouts/inbox-sub-sidebar.tsx (presence)
   - apps/web/src/features/inbox/components/contact-panel.tsx (presence)
   - apps/web/src/features/inbox/components/message-thread/assignment-dropdown.tsx (presence)
   - apps/web/src/features/inbox/components/inbox-shell.tsx (providers/calling-regions — this file is in the modified-but-not-WIP-calls set; it's inbox code consuming a region helper)

2. FAILURE MODE IS REAL. The auto-memory `project_shared_runtime_resolution.md` documents the exact pattern: tsconfig paths bypass the exports gate at runtime so static imports compile and bundle, but native ESM resolution (dynamic import, bare node script, certain bundler tightenings) hits ERR_PACKAGE_PATH_NOT_EXPORTED. The same memory records that two identical omissions (`outbound-webhooks/public-events`, `workflow-shapes`) were filed and fixed during the 2026-05-22 infra audit — establishing precedent that this class of gap is treated as worth closing.

3. NOT INTENTIONAL/LOCKED/DEFERRED. CLAUDE.md and memory do not flag missing exports as intentional; the opposite, the memory says "Keep it complete anyway."

4. SEVERITY APPROPRIATE. Medium is fair — latent, no current user impact, but a real contract gap with a known failure mode. Not Critical (no app-down), not Low (the presence feature is load-bearing for inbox + app rail per the user-availability memory).

5. PROPOSED FIX IS SAFE AND IN-PATTERN. Adding the two entries matches what was already done for two other subpaths in the same map. The wildcard suggestion is optional.

One small caveat: the calls.service.ts and other apps/api/src/calls/* imports of providers/calling-regions are inside the explicitly-excluded WhatsApp-calling WIP. But inbox-shell.tsx's import is not WIP, and the entire presence cluster (5 web files) is shipped code from 2026-05-26 — so the finding stands on those alone.


## M2. Recovery refetch reconcile races optimistic media-blob bubbles into a phantom-failed retry
_Chat (highest priority)_ · `apps/web/src/features/inbox/hooks/use-conversation-events.ts:98-109`

**Problem.** `reconcileOptimisticAgainst` (use-conversation-events.ts:98-109) drops pending OUT optimistic rows when a recovery fetch (delta or full refetch) brings back a server row whose `body` matches. But for media-only sends (caption-less voice/image/video), `body` is empty by design (the optimistic bubble carries the media blob with no caption). The comment says "Empty bodies (media without caption) are skipped so distinct attachments aren't collapsed" — but that means the optimistic bubble for a caption-less media is NEVER reconciled by the recovery path.

**Why dangerous.** If a disconnect swallowed the confirming `message:new` frame for a caption-less voice note / image / video send (the very case recovery exists to handle), the recovery refetch re-adds the server row, the externalId-dedupe leaves the optimistic blob bubble in place too, the 30s reply-box watchdog never sees `ccp:optimistic-confirmed:<tempId>` (because the live `onMessageNew` reconciler is what fires that event), and the optimistic bubble flips to phantom "failed" with a Retry button — inviting a double-send of the SAME message.

**Impact.** Voice notes + caption-less photos sent during a reconnect blip can show "failed" with a Retry button even though Meta delivered them, exactly the duplicate-send risk this reconciler was added to prevent (per the file header comment line 88-97).

**Fix.** Match by `(direction, clientTempId)` when available on either side, or by a fallback (mediaKind + mediaSizeBytes when both sides carry media). The recovery payload does include media — extend the predicate to also drop a pending OUT row whose `media.kind === server.media.kind && media.sizeBytes === server.media.sizeBytes` (or just by clientTempId if the server's recovery rows carry one).

**Verifier note.** Verified against the actual code at /home/aliubuntu/projects/loadless_projects/customer-communication-platform/apps/web/src/features/inbox/hooks/use-conversation-events.ts:98-109. The finding is real.

CHAIN VERIFIED:
1. Optimistic media bubble at reply-box.tsx:630-653 has `externalId = clientTempId` (local UUID) and `body = effectiveCaption` which is "" for caption-less voice/image/video sends (line 605: `effectiveCaption = overrideFile ? "" : trimmed`). Voice sends always go through overrideFile path → body always empty.
2. `reconcileOptimisticAgainst` (lines 98-109) builds the `confirmed` set from `fresh.filter((m) => m.direction === "out" && m.body)` — explicitly skips empty bodies. Comment at line 95-96 acknowledges this is intentional.
3. The `externalId`-based dedupe in runBackfill (line 609-610) and runFullRefetch (line 705,713) compares wamid (server) vs clientTempId (optimistic) — never matches. Server row IS appended alongside the optimistic.
4. `mapMessage` at apps/api/src/lib/queries/_shared.ts:210-257 does NOT include `clientTempId` on the returned shape — confirmed: it's not selected from the DB, not mapped to the DTO. So even a clientTempId-based reconcile in recovery couldn't work without an API change.
5. `ccp:optimistic-confirmed:<tempId>` is dispatched ONLY inside `onMessageNew` (line 815-821 of use-conversation-events.ts). The recovery refetch paths do NOT dispatch it. So the 30s STUCK_WATCHDOG_MS at reply-box.tsx:829-840 fires `onOptimisticFail` → bubble flips to failed.
6. Retry generates a NEW clientTempId (reply-box.tsx:545 comment "Each retry has a [new tempId]"). BullMQ's jobId idempotency keys off clientTempId (apps/api/src/messages/send-queue.ts:118) — so a retry with a NEW tempId bypasses the dedupe and double-sends to Meta. The customer receives two copies of the voice/photo/video.

SEVERITY: Medium is correct.
- Trigger window is real but narrow: needs HTTP success + live message:new missed + recovery within ~30s
- Reconnect blips, page-reload-during-send, mobile network drops all hit this
- Caption-less voice messages are a routine WhatsApp UX (one-tap voice memo) → realistic frequency
- User-visible failure (phantom Retry + duplicate bubble) AND money-burning on retry (double-send to customer's WhatsApp)
- Not Critical because: (a) the HTTP-response idempotency on the FIRST POST + BullMQ jobId on the same tempId still catch the original send (only the retry doubles), (b) the user has to click Retry on a "failed" bubble that just landed alongside a successful-looking one, so behavioral mitigation exists
- Not Low/High — sits squarely in "Medium correctness/UX gap with double-send tail risk"

NOT listed as deferred/intentional in CLAUDE.md or memory. The file header comment at lines 86-97 explicitly frames `reconcileOptimisticAgainst` as the guard against this exact bug class, then notes the empty-body skip as an intentional carve-out — but the carve-out's downside (caption-less media falling through) doesn't appear to have been weighed; the comment frames it only as "don't collapse distinct attachments."

Proposed fix is sound: extending the predicate to also match `(direction, mediaKind, mediaSizeBytes)` for own-OUT rows that have media but no body would close the gap without risking collision (sizeBytes is highly distinguishing for the rare two-identical-media-in-a-row case). Alternative: include `clientTempId` in `mapMessage` for OUT rows owned by the calling session — also clean. Either fix is safer than the current code.


## M3. Doc drift: assignment status side-effect comment contradicts the code
_Code quality / dead code / duplication_ · `apps/api/src/conversations/conversations.service.ts:308-317`

**Problem.** `apps/api/src/conversations/conversations.service.ts:314-315` doc-comment says "Assign to a user + status was `pending`/`closed` → becomes `open`" but the actual rule implemented in `apps/api/src/lib/conversations/mutations.ts:153-159` (and mirrored in the client predictNextStatus) is: assign+closed → pending, unassign+open → pending, never sets `open` (per the locked memory rule "Assignment never sets open"). The comment was likely written against an earlier draft of the rule.

**Why dangerous.** The next person reading the JSDoc to wire a workflow/audit subscriber will encode the wrong cause-then-effect ordering or set the wrong next-status. The memory entry says `predictNextStatus mirrors server — keep in sync` — but the spec-of-record currently lies about both. A drive-by "fix" that tries to make code match this comment would flip a load-bearing product rule.

**Impact.** Maintenance/correctness landmine. Single-developer pilot today, but the comment is the first thing any future agent reads before changing assignment logic, so it has outsized blast radius the moment assignment rules change again.

**Fix.** Rewrite the doc-comment to match the implementation (and the client's `predictNextStatus`): `closed + assign → pending`, `open + unassign → pending`, all other combinations unchanged; assignment NEVER produces `open` (only an agent reply does, via claim-on-reply). Single-source the rule in the mutations.ts doc block and just point the service method's doc at it.

**Verifier note.** Verified at both cited locations and against the locked memory rule.

1. Code at `apps/api/src/lib/conversations/mutations.ts:153-159` is unambiguous: comment "Assignment NEVER sets 'open'", and the only flips are `assign + closed → pending` and `unassign + open → pending`.

2. JSDoc at `apps/api/src/conversations/conversations.service.ts:308-330` states the opposite rule across THREE lines, not just two:
   - L314: "Assign to a user + status was `pending`/`closed` → becomes `open`"
   - L319-320: "re-assigning the SAME already-assigned user while the chat is `pending` (or `closed`) still promotes it to `open`"
   - L324: "Both transitions are bounded (`closed → open` and `open → pending`...)"
   The drift is internally consistent with the OLD rule, not the implementation.

3. The locked memory `project_assignment_status_rules.md` explicitly says: "Old (removed) rule was `assign while !=open → open`. Don't reintroduce." So the JSDoc is preserving a rule the team deliberately removed and (per memory) re-ratifies as a hard "don't reintroduce".

4. Severity Medium is right: no runtime bug today (implementation is correct), but the spec-of-record on the public service method is the first thing the next agent reads when touching assign logic — and the memory entry itself warns "predictNextStatus mirrors server — KEEP IN SYNC". A drive-by "fix" to make code match the doc would re-introduce the removed rule and flip a load-bearing product behavior. Not Critical or High (no user-facing failure now), not Low (it's the canonical spec, not a stray comment).

5. Proposed fix (rewrite the JSDoc to match implementation; single-source the rule in mutations.ts) is strictly safer — it removes the contradiction without touching runtime code.

Location is accurate (lines 308-317 cited, full drift spans 308-330).


## M4. Bulk audience resolution loads ALL contacts in `mode='all'` without the runner's safety cap
_Contacts / pipeline (stages/tags/filters/audience/broadcasts)_ · `apps/api/src/broadcasts/broadcasts.service.ts:195-201 (and the `recipients.create` block at line 312-314)`

**Problem.** `BroadcastsService.create` for `audience.mode === 'all'` runs `db.contact.findMany({ where: { teamId, deletedAt: null }, select: { id: true } })` with NO LIMIT, then writes one BroadcastRecipient row per contact. Only AFTER that does the runner check `MAX_RECIPIENTS_IN_PROCESS = 10_000` and fail the broadcast. For a 50k-contact team the create endpoint allocates 50k ids in memory, builds a 50k-element `recipients.create` array on the prisma payload, performs a multi-second insert of 50k rows, then the runner immediately marks the broadcast `failed` for being too large — wasting DB throughput, BroadcastRecipient table bloat, and tying up the connection for many seconds (visible as a stall on the operator's POST).

**Why dangerous.** An operator unaware of the cap who picks 'All contacts' on a large tenant burns DB resources for an operation that will fail anyway. On a single VPS pilot this stalls unrelated requests on the same connection pool. Also: a one-tx 50k `recipients.create` may blow Postgres parameter limits / statement timeout depending on prisma chunking.

**Impact.** Tenants with >10k contacts hitting 'all' mode (or a tag with >10k carriers) experience a multi-second POST that fails. Up to MAX_RECIPIENTS_IN_PROCESS hard cap, no harm; past it, expensive failure + leftover broadcast row + 50k recipient rows that must be deleted manually.

**Fix.** Push the cap into `BroadcastsService.create`: run `db.contact.count({ where: { teamId, deletedAt: null } })` (or for tag/group modes, count via the same WHERE) and refuse with a clear BadRequestException citing the cap when count > MAX_RECIPIENTS_IN_PROCESS. Keep the runner's cap as defense-in-depth. Bonus: chunk the `recipients.create` into 1k-row batches via `db.broadcastRecipient.createMany` to avoid the giant single insert.

**Verifier note.** Verified the cited code path. apps/api/src/broadcasts/broadcasts.service.ts:195-201 does `db.contact.findMany({ where: { teamId, deletedAt: null }, select: { id: true } })` with no LIMIT for `audience.mode === 'all'`. Lines 294-317 then build a `db.broadcast.create` with `recipients: { create: recipientIds.map(...) }` — a nested create that emits N inserts. Only AFTER `startBroadcast(broadcast.id)` does `runBroadcast` (apps/api/src/lib/broadcast-runner.ts:319-328) execute `db.broadcastRecipient.count(...)` and `fail()` the broadcast if >10k. The cap is structurally AFTER the heavy work, not before.

The same no-cap pattern repeats for `by_tag` (line 222-225), `group` (`resolveAudienceGroupMembers`), `custom` (line 268-271), and `selected` (line 274-283); the finder's fix should cover all modes, not just 'all'.

The runner cap (`MAX_RECIPIENTS_IN_PROCESS = 10_000`) is explicitly named in CLAUDE.md as a soft trigger ("Move broadcast runner to a separate worker / BullMQ — only when a single broadcast crosses ~10k recipients"), not as a production-grade input guard, so the in-create cap is additive, not redundant.

Mitigating factors that keep this at Medium (not Critical):
- Pilot stage, one customer, unlikely to have >10k contacts today.
- The broadcast wizard UI already calls /count-all and surfaces team size, giving operators a visual hint before they click submit (though it's not enforced).
- Failure mode is wasted DB work + a leftover failed broadcast row + N orphan recipient rows + a few-second POST stall — not data loss, not security, not money-burning. One connection is held, not the whole pool.

Mitigating factors that keep this at Medium (not Low):
- The stall + orphan rows are operator-visible and require manual cleanup.
- The runner's recipient-row count cap (10k) governs a different invariant (memory/heap inside the runner) than what the finder is asking the create endpoint to enforce (avoid building a 50k-element insert in one transaction in the first place).
- Adding `db.contact.count()` (or matching count by mode) before the heavy findMany + nested-create is cheap and the proposed fix is strictly safer than the current code — no new failure mode introduced.

Confidence: high. The code matches the claim, the failure mode is reachable, and the severity is correctly calibrated.


## M5. Bulk-tag / setTags / update operate on soft-deleted contacts
_Contacts / pipeline (stages/tags/filters/audience/broadcasts)_ · `apps/api/src/contacts/contacts.service.ts:347-352 (update), :528-531 (bulk lookup), :1195-1199 (setTags)`

**Problem.** `ContactsService.bulk` looks up `ownContacts` with `where: { teamId, id: { in: ... } }` (no `deletedAt` filter), and the tag-add/tag-remove raw SQL doesn't filter `deletedAt` either. Same for `ContactsService.setTags` (line 1195-1199) and `ContactsService.update` (line 348-393) — the existence check on `findFirst` doesn't filter soft-deleted rows, so an agent (or a stale UI) holding a deleted-contact id can mutate name/email/customFields/tags/stage on a tombstoned row. Workflow + audit subscribers then fire for the change, and the per-contact `contact.updated` socket emits drive other clients to patch their lists for a contact that should be invisible. (Bulk delete itself correctly filters `deletedAt: null`.)

**Why dangerous.** Two inconsistent surfaces: the list/audience queries hide soft-deleted rows but mutators happily edit them. Stale clients (open before a delete) become an automation footgun — a workflow trigger fires on a contact whose conversation may also be in a 'deleted-but-preserved' state, surprising operators. Long-term this also makes soft-delete semantics ambiguous when admins need to audit who touched what.

**Impact.** Per-tenant, occasional. Edits/tag-adds to deleted contacts → bogus workflow + audit events. The contact stays invisible in the directory but its conversation receives 'tagged'/'updated' activity pills, and any open broadcast wizard that pre-snapshotted the id would silently include it (audience-group resolver IS guarded, but a manual `contactIds: [...]` selection isn't until it hits resolveAudienceGroupMembers — which IS guarded).

**Fix.** Add `deletedAt: null` to: the `findFirst` for update + setTags, and the `ownContacts` lookup in `bulk`. The tag-add/tag-remove raw SQL should add `AND "deletedAt" IS NULL` to its CTE join. Same for `lookupContacts` (apps/api/src/lib/queries/contacts.ts:247-258) which is hit by the client `contacts:bulk_updated` handler — `where: { teamId, deletedAt: null, id: { in: clean } }`.

**Verifier note.** Verified all three cited locations match the claim exactly:

- contacts.service.ts:348-352 (`update` → `findFirst({ where: { id: contactId, teamId } })` — no `deletedAt` filter, then proceeds to `tx.contact.update({ where: { id, teamId, version }, ... })` which also matches a soft-deleted row)
- contacts.service.ts:528-531 (`bulk` → `findMany({ where: { teamId, id: { in: input.contactIds } } })` — no `deletedAt` filter on `ownContacts`; then tag-add/tag-remove raw SQL filters only by `teamId`, and version-bump `UPDATE` likewise)
- contacts.service.ts:1195-1199 (`setTags` → `findFirst({ where: { id: contactId, teamId } })` — no `deletedAt` filter, then `tags: { set: ... }`)
- lib/queries/contacts.ts:255-258 (`lookupContacts` → `findMany({ where: { teamId, id: { in: clean } } })` — no `deletedAt` filter)

Contrast the same file's correct patterns: the `remove()` path filters `deletedAt: null` at line 481, the count helpers do at 1414, the soft-delete branch in `bulk` does at line 543, and the audience-group resolver filters consistently (audience-groups.ts:45, 140, 146, 183, 187, 188, 216, 218, 219). The asymmetry is real: read/list/audience paths hide tombstoned rows, but the three primary mutation paths do not refuse to operate on them.

Reachability: any authenticated agent on a stale tab (panel/list opened before a delete from another agent) can fire PATCH `/api/contacts/:id`, POST `/api/contacts/bulk` (tag-add/remove), or PUT/POST setTags with a tombstoned id. These mutations succeed, bump version, write tag join rows, and publish `contact.updated` on the bus → workflow + audit subscribers process them, plus a `contact.bulk_updated` socket frame goes out. Not a cross-tenant escape (teamId still gates), not data corruption, but a soft-delete contract violation that produces bogus workflow triggers and audit timeline entries on a tombstoned contact.

Not listed as intentional/locked/deferred in CLAUDE.md or memory. The "soft-delete preserves conversations" rule is documented; mutation guards on the tombstoned row are not called out as deliberate.

Severity Medium is correct: pilot-scale per-tenant occasional bug; no user-visible data loss; the audience-group + list/search surfaces already filter the row out, so the surface is narrow to stale-client / direct-API. Proposed fix (add `deletedAt: null` to `findFirst`/`findMany`, add `AND "deletedAt" IS NULL` to the tag CTEs, same on `lookupContacts`) mirrors the existing `remove()` and audience-group patterns; doesn't conflict with the ingest revive path which uses its own `deletedAt: { not: null }` query (line 249).


## M6. Broadcast `retryFailed` runs reset + counter-decrement OUTSIDE a transaction
_Contacts / pipeline (stages/tags/filters/audience/broadcasts)_ · `apps/api/src/broadcasts/broadcasts.service.ts:581-602`

**Problem.** `BroadcastsService.retryFailed` calls `broadcastRecipient.updateMany({ status: 'failed' } → 'queued')` and then `broadcast.update({ failedCount: { decrement: reset.count } })` in two separate round-trips with no transaction wrapping them. If the first succeeds and the second errors (network blip, statement timeout, server restart), the recipient rows are queued but the parent `failedCount` is unchanged, so the broadcast UI shows N queued + N failed = N more than `totalCount`. The runner doesn't reconcile counts on resume — it only increments on send completion. The drift is permanent until manual repair.

**Why dangerous.** Reasonably rare in steady-state but a real correctness regression after the retryFailed is shipped as a customer-facing button. Drift compounds across multiple partial-failure retries on the same broadcast.

**Impact.** Per broadcast that was retried during a DB blip: incorrect parent counters, confusing UI (total never reached), audit numbers off. Won't bite until pilot users start exercising retry-failed under load.

**Fix.** Wrap both writes in `this.db.$transaction(async tx => { ... })`. While in there, also CAS the parent on `status: { in: ['completed','failed','canceled'] }` so a race with a concurrent runner status-flip doesn't reopen a broadcast that the runner is already terminating.

**Verifier note.** Confirmed at /home/aliubuntu/projects/loadless_projects/customer-communication-platform/apps/api/src/broadcasts/broadcasts.service.ts:581-602 — code exactly matches the claim: a `broadcastRecipient.updateMany` (failed→queued) followed by `broadcast.update` (failedCount decrement + status flip to queued) with no `$transaction` wrapping them.

Failure mode is real and reachable:
- If the second write fails (statement timeout, connection drop, container restart between roundtrips), the recipient rows are `queued` but the parent broadcast remains in a terminal state (`completed`/`failed`/`canceled`) with stale `failedCount`.
- The runner at apps/api/src/lib/broadcast-runner.ts:310 explicitly bails when `broadcast.status !== "queued"`, so the stranded recipients are NEVER picked up. `startBroadcast(id)` on line 603 is fire-and-forget so the caller never sees the partial state.
- The boot reconciler (line 1209 area) only revives `running` broadcasts, not terminal ones. There is no counter-reconciliation routine — `bumpCounters` (line 1090) is the only failedCount writer and it only increments per-send. So the drift is permanent until manual SQL repair.
- A user retrying the broadcast a second time gets "nothing to retry" because the rows are already `queued`, not `failed`.

Severity assessment: I think Medium is slightly understated. The user-visible failure isn't just "wrong counters" — N customers never receive the broadcast message at all, and a subsequent retry attempt is blocked because the recipients are already `queued`. That said, the trigger window (failure of the second statement, between two same-process Postgres writes) is genuinely small in practice, so Medium is defensible. The finder's articulation focuses on counter drift; the actual blast radius is somewhat worse (silently undelivered recipients + jammed retry button), which the fix would also resolve.

Not listed as deferred/intentional in CLAUDE.md or memory. The broadcast-scheduling and event-safety memory entries flag broadcast correctness as a focus area; this gap fits the same pattern.

Proposed fix (wrap in `$transaction`, add CAS on terminal status) is safe and standard — no worse failure mode introduced. The terminal-status CAS inside the tx makes the existing line-575 guard atomic with the writes.


## M7. Contact list `customFields::text ILIKE` defeats the GIN index — full sequential scan on search
_Contacts / pipeline (stages/tags/filters/audience/broadcasts)_ · `apps/api/src/lib/queries/contacts.ts:110-119`

**Problem.** `listContacts` adds `OR c."customFields"::text ILIKE '%search%'` to the per-contact search WHERE. The existing `Contact_customFields_gin_idx` is a `gin (customFields jsonb_path_ops)` index — it accelerates JSON containment operators (`@>`, `?`, `?|`, `?&`), NOT a text cast + ILIKE. Postgres therefore falls back to a sequential scan of the whole Contact table for every searched substring, and the scan happens BEFORE the keyset pruning predicate is evaluated. At ~50k-100k contacts this becomes the dominant cost of every typeahead keystroke. Email search on the same query (line 115) is also unindexed (only `name` and `phoneNumber` have trgm indexes).

**Why dangerous.** Latency cliff once a tenant grows past a few thousand contacts. The query is called from the contacts list (every keystroke) AND from the resync code path triggered by stage/tag changes. A busy team with even 30k contacts will see >100ms search latency that scales with N — the kind of regression that looks fine in dev and bites pilot customers as their directory grows.

**Impact.** Pilot tenants with a few-thousand-to-tens-of-thousands of contacts. Search becomes increasingly laggy; one slow query can also drain connection pool on the single-VPS deploy and bleed into unrelated requests.

**Fix.** Two options, pick one. (a) Drop the customFields branch from the team-wide search and surface custom-field search through the existing `fieldKey`+`fieldValue` filter only (it's already JSON-path-indexed via the `?>` operator). (b) If the broad-text search over customFields is wanted, add `CREATE INDEX Contact_customFields_text_trgm_idx ON "Contact" USING gin (("customFields"::text) public.gin_trgm_ops);` in a new migration. Same applies to email — either add a partial trgm on `email` or accept that email search is rare enough to defer. The Contact_customFields_gin_idx note in `migrations_squashed_to_single_init` memory rules out regenerating the existing one; ADD a new index, don't touch that one.

**Verifier note.** Code at apps/api/src/lib/queries/contacts.ts:110-119 matches the finding exactly: the raw-SQL search WHERE includes `c."customFields"::text ILIKE '%search%'` and `COALESCE(c.email, '') ILIKE '%search%'`. Verified the index inventory in prisma/migrations/0_init/migration.sql: `Contact_customFields_gin_idx` uses `gin (customFields jsonb_path_ops)` — this opclass only accelerates JSON containment/key-existence operators (`@>`, `?`, `?|`, `?&`), it cannot serve a `::text ILIKE` predicate. Only `Contact.name` and `Contact.phoneNumber` have `gin_trgm_ops` indexes; `Contact.email` and the `customFields::text` cast have none. So the OR chain on every searched keystroke forces a sequential scan of Contact before keyset pruning is evaluated — exactly the failure mode described. Memory note "Migrations squashed to single init" explicitly preserves the existing `jsonb_path_ops` index as untouchable, which is consistent with the finder's "ADD a new index, don't touch that one" guidance. Not in CLAUDE.md "intentional/locked/deferred" list. Severity Medium is correct: the severity guide says Medium = "correctness/maintainability problem, not user-visible yet" and the High bar is "will bite under load or within weeks of pilot." At pilot scale (one customer, likely sub-5k contacts) the seq scan is fast in absolute terms; the cliff only appears as a tenant's directory grows. Fix proposals are concrete (file/index names given) and the index-addition option doesn't risk worse failure modes — adding a trigram GIN on `("customFields"::text)` is a pure read-path acceleration with bounded write-amplification on contact upserts. The finding stands as written.


## M8. Broadcast.create with nested recipients: { create: [...] } ships an unbounded mega-INSERT
_Database / Prisma / queries / migrations_ · `apps/api/src/broadcasts/broadcasts.service.ts:294-317 (Broadcast.create with nested recipients) + apps/api/src/lib/queries/audience-groups.ts:130-153 (unbounded resolveAudienceGroupMembers)`

**Problem.** BroadcastsService.create builds the full recipient list in memory via resolveAudienceGroupMembers / findMany-all-contacts then passes it as a nested-create on a single Broadcast.create call (apps/api/src/broadcasts/broadcasts.service.ts lines 196-201, 222-226, 250-253, 268-271, 277-281, 294-317). At an `all`-audience send for a team with 50k contacts that's one Prisma operation that allocates ~50k JS objects, ships ~megabytes of bind params over the pg adapter, and runs as one giant statement. The 25/50-slot pool spends the entire send-create operation holding one connection, and node heap takes the hit. The downstream recipient-runner queries (broadcastRecipient.findMany) then pull the same 50k rows back.

**Why dangerous.** P0 latency cliff for any pilot customer who hits Broadcasts → All Contacts on a moderately-sized contact base. The single HTTP request blocks waiting for the create round-trip; the pg statement may exceed the configured `statement_timeout: 30_000` and return P2024/timeout on a freshly-imported team (50k contacts × tags). The user sees a generic 500 with no recovery path — Broadcast row may or may not have committed.

**Impact.** Pilot-blocking when a customer with >~20k contacts attempts an 'All' broadcast. CLAUDE.md flags 10k+ recipient broadcasts as the trigger point for moving the runner to a worker; the CREATE PATH itself is silently the cliff long before that.

**Fix.** Replace the nested-create with: (1) Broadcast.create returning just the id (no recipients), then (2) chunked BroadcastRecipient.createMany({ data, skipDuplicates: true }) in batches of ~1000 inside a tx-or-not (Prisma's createMany is a single INSERT…VALUES). Pull recipient ids in a stream via raw SQL with a hard LIMIT cap. Cap the absolute recipient count (env-driven, e.g. BROADCAST_MAX_RECIPIENTS=10000) and 400 above it so the operator chooses a smaller audience.

**Verifier note.** The finding accurately identifies the code at the cited locations: `apps/api/src/broadcasts/broadcasts.service.ts:294-317` does use a nested `recipients: { create: recipientIds.map((id) => ({ contactId: id })) }`, and the only audience-size guard is the empty check at line 286 — no upper cap. `resolveAudienceGroupMembers` at `audience-groups.ts:130-153` is indeed unbounded. `statement_timeout: 30_000` at `db.service.ts:62` is also confirmed. So the technical claim is real.

However, the severity is overstated for pilot stage:

1. CLAUDE.md explicitly lists broadcast scaling in the "Scaling cliffs to anticipate (DON'T pre-build)" section: "10k+ recipient broadcasts: in-process loop holds too much state. Move to a worker." Memory note "Architecture re-audit PASS 3 2026-05-25" flags broadcast runner scaling as deferred (P1, latent at 1 customer).

2. The pilot is one customer at MVP; the "50k contact" failure shape the finder describes is well above realistic pilot scale. The finder's narrower claim that "the CREATE PATH is silently the cliff long before the runner cliff" is correct in principle (Prisma nested-create emits N individual INSERTs in a single tx — would 30s-timeout at recipient counts smaller than the 10k runner threshold), but the actual blast radius at pilot scale is small.

3. The finder's fix (chunked createMany + env-driven max cap) is correct and low-risk, but introducing it now without a customer-visible trigger contradicts the locked "don't pre-build scaling cliffs" posture — and the broader audit-memory pattern shows the team has repeatedly chosen to defer this class of work.

4. A factual nit on the finding's wording: nested-create in Prisma does NOT actually ship "one giant statement"; it emits N individual INSERTs inside one transaction. That's why it bottlenecks on round-trips + connection-hold, not on bind-parameter size or one giant SQL string. The mechanism is real, the description is slightly mischaracterized.

Net: the issue is real and pre-pilot-worth-considering (specifically, the CREATE timeout hits earlier than the runner cliff CLAUDE.md flags), but High overstates urgency given pilot scale of 1 small customer. Medium is appropriate — correctness/scaling problem, not currently user-visible at pilot scale, fix is straightforward when triggered. Severity should be revised to Medium.


## M9. Global note search (searchAllNotes) has no usable order/keyset index — team-wide sort scales linearly
_Database / Prisma / queries / migrations_ · `apps/api/src/lib/queries/global-search.ts:261-272 (searchAllNotes); apps/api/src/lib/queries/global-search.ts:168-197 (searchAllMessages)`

**Problem.** searchAllNotes queries InternalNote with `WHERE teamId = ? AND body ILIKE ?` (rides InternalNote_body_trgm_idx) but then ORDER BY `(timestamp DESC, id DESC)` with no composite supporting index (apps/api/src/lib/queries/global-search.ts:241-292). Existing InternalNote indexes are `(conversationId, timestamp)`, `(teamId)`, and the body GIN — none can serve `(timestamp DESC, id DESC)` after a team-wide trgm match. Postgres will pull every matching row from the trgm GIN, sort it, then keyset-slice. Same shape applies to searchAllMessages on Message: `Message_body_trgm_idx` gives the candidate set, but team-wide ORDER BY (timestamp DESC, id DESC) has no composite (`(teamId, timestamp DESC, id DESC)` would, but doesn't exist — `Message_teamId_idx` is `(teamId)` only).

**Why dangerous.** First time a team's note/message corpus crosses ~100k rows AND an agent types a common substring (e.g. 'invoice'), the global-search tab becomes a multi-second seq-sort that pins a pool slot for every keystroke (the UI fires a query per debounced input). 'Tab' compounds: the same search runs across messages + comments + contacts simultaneously.

**Impact.** User-visible: global search tab feels frozen for the operator triggering it. Backend: holds 1-3 pool connections per active search for the full sort duration; concurrent searches by 3-4 agents on the same team eat the pool when combined with normal REST traffic.

**Fix.** Add composite indexes that support the post-trgm sort: `@@index([teamId, timestamp(sort: Desc), id(sort: Desc)])` on Message and `@@index([teamId, timestamp(sort: Desc), id(sort: Desc)])` on InternalNote. Postgres can then bitmap-AND the trgm GIN with the btree to keep both filter and order efficient. Add hard-take cap (e.g. clampTake max 25, already done) + reject queries shorter than 2-3 chars (already done — query.length === 0 only; raise to 3).

**Verifier note.** The code shape is correctly described. Confirmed at apps/api/src/lib/queries/global-search.ts:168-197 (searchAllMessages) and 261-272 (searchAllNotes): both ORDER BY (timestamp DESC, id DESC) after a teamId + trgm-ILIKE filter. Confirmed via prisma/migrations/0_init/migration.sql that the only relevant InternalNote indexes are body_trgm_idx, (conversationId, timestamp), teamId; and Message has body_trgm_idx, (teamId), (conversationId, timestamp ASC) and (conversationId, timestamp DESC, id DESC) but NO (teamId, timestamp DESC, id DESC). So Postgres has no composite that serves the team-wide post-trgm sort, exactly as claimed.

Severity is overstated, however:
1) The frontend (apps/web/src/features/inbox/hooks/use-inbox-search.ts) debounces 250ms AND aborts the in-flight fetch on each keystroke, so the "query per keystroke" framing is wrong — at most one in-flight query per scope per user, and stale ones get cancelled.
2) clampTake + DEFAULT_TAKE=25 caps each page; the controller short-circuits q.length===0; GlobalSearchQuerySchema caps q at 200 chars.
3) Global RateLimitGuard already applies (300/min default per user).
4) Pilot is one customer; the claim that 3-4 concurrent agents on 100k+ rows will eat the pool isn't reachable yet — this is a latent scale cliff, not a near-term pilot blocker.
5) The proposed composite indexes are useful (early-terminate index walk + recheck when the trgm match isn't very selective) but won't always be a clear win when bitmap-ANDed (heap scan loses ordering, still needs a sort). The fix has real value but isn't a silver bullet — Medium reflects that.

This is a real index gap worth filing on the post-deploy backlog, but it's a Medium scale-cliff (latent at 1 customer, bites at "team crosses ~100k messages/notes AND types a common substring"), not a High-severity pilot risk. The finder's own framing ("first time a team crosses ~100k") effectively concedes this.


## M10. WorkflowRun terminal-row retention sweep has no usable index
_Database / Prisma / queries / migrations_ · `apps/api/src/lib/sweepers/workflow-run-retention.ts:72-79 (sweep query); prisma/schema.prisma WorkflowRun model indexes`

**Problem.** workflow-run-retention sweepOnce queries `WorkflowRun WHERE status IN ('completed','failed','skipped') AND startedAt < cutoff` (apps/api/src/lib/sweepers/workflow-run-retention.ts:71-79). Existing indexes are `(workflowId, startedAt DESC)`, `(teamId, startedAt DESC)`, `(status, waitUntil)`, plus the new `WorkflowRun_active_startedAt_idx` partial WHERE status IN ('queued','running','waiting'). The sweep filter is the COMPLEMENT of that partial — it targets terminal statuses. None of the existing indexes match: the partial index excludes terminals, the (status, waitUntil) index has waitUntil NULL for terminals so the btree is degenerate for the `startedAt < cutoff` predicate, and the teamId/workflowId-leading indexes can't serve a status-led scan.

**Why dangerous.** WorkflowRun is documented as the fastest-growing table at automation scale (one row per dispatched workflow). The daily sweep starts seq-scanning the terminal-row bulk past ~1M rows. Sweep window is bounded (MAX_PER_SWEEP × MAX_BATCHES = 80k/day), so it self-limits, but the scan duration linearly degrades and starts holding a pool connection for tens of seconds while the rest of the table sits write-locked-ish for the bounded deleteMany.

**Impact.** Quiet correctness — sweep keeps working but becomes slower and more pool-contended every week. Bites month 3-6 of a multi-tenant deploy with active workflows.

**Fix.** Add a partial complementary index: `CREATE INDEX WorkflowRun_terminal_startedAt_idx ON "WorkflowRun" ("startedAt") WHERE status IN ('completed','failed','skipped');` (hand-written, partial-index — same pattern as the existing WorkflowRun_active_startedAt_idx). Or add a non-partial `@@index([status, startedAt])` if the partial isn't expressible.

**Verifier note.** Independently verified:

1. **Code matches.** apps/api/src/lib/sweepers/workflow-run-retention.ts:71-79 runs exactly `findMany WHERE status IN ('completed','failed','skipped') AND startedAt < cutoff` in a batched loop. Confirmed verbatim.

2. **Index inventory matches.** prisma/schema.prisma:1376-1380 declares exactly the three @@index entries the finder named: `(workflowId, startedAt DESC)`, `(teamId, startedAt DESC)`, `(status, waitUntil)`. The partial `WorkflowRun_active_startedAt_idx` from migration 20260529180000 covers WHERE status IN ('queued','running','waiting') — the COMPLEMENT of the retention filter. The finder's analysis is precise.

3. **Failure mode is real and accepted-as-real by this team's prior work.** Migration 20260529120000_outbound_event_retention_index/migration.sql is verbatim the same pattern: existing partial index covered the drainer's pending case, sweeper filtered the complement, team added `OutboundEvent_retention_idx` as a hand-written partial. The docstring on that migration spells out the exact "until this index lands the daily sweep does a full table scan + lock-while-deleting that grows linearly" failure mode. WorkflowRun is the same shape, and the file's own header (line 8) calls it "the fastest-growing table in the schema at real automation volume". The team clearly considers this kind of fix in-scope, not deferred.

4. **Not in CLAUDE.md or memory as intentional/deferred.** Memory shows multiple sweeper/index audits but none waiving this specific case.

5. **Severity is right.** Medium fits: self-bounded (MAX_PER_SWEEP × MAX_BATCHES = 80k/day), but pool-contention + sweep duration grow linearly with table size. Not a pilot-day-1 blocker; bites month 3-6 at multi-tenant automation scale. Won't lose data, just degrades quietly.

6. **Fix is safe.** Partial index on `startedAt` keyed to terminal statuses, identical pattern to `OutboundEvent_retention_idx` and `Contact_teamId_active_idx`. Negligible INSERT write tax (terminals are written once at row completion). No new failure mode introduced.

The (status, waitUntil) index doesn't rescue the sweep — even though btree indexes NULL values, it lacks startedAt for predicate evaluation, so the planner falls back to seq scan or index-then-heap-fetch on 99% of the table once retention kicks in. Finding stands at Medium.


## M11. Web upstream health-couples to api — api outage = 502 for /login + static pages
_Deployment / production / docker / migrations_ · `deploy/Caddyfile.template:215 (health_uri /api/health on web upstream) + apps/web/src/app/api/health/route.ts:65-83 (returns 503 if api probe fails)`

**Problem.** Both Caddy's default (web) reverse_proxy block (deploy/Caddyfile.template:215, `health_uri /api/health`) and the web container's Docker healthcheck (docker-compose.yml:252 + apps/web/Dockerfile:225, `wget -qO- http://127.0.0.1:3000/api/health`) consult `/api/health`. That endpoint (apps/web/src/app/api/health/route.ts:37-67) returns 503 when api is unreachable. So whenever api is restarting (graceful drain up to 100s, or a slow `prisma migrate deploy` that can push start_period to 120s), Caddy marks the WEB upstream unhealthy and returns 502 for every default-block path (`/`, `/login`, `/_next/*`, `/api/auth/*`) — even though Next.js itself is up and the auth pages have no api dependency.

**Why dangerous.** An api-only incident (a stuck BullMQ drain, a hot-reload of api, even the deploy of an api-only change) becomes a total outage of marketing/login pages. Users seeing 502 on `/login` during a routine api restart can't sign in to file the support ticket. During a deploy with a non-trivial migration this surfaces every time.

**Impact.** Every deploy that recreates the api container causes a ~30s-2min window of 502s on ALL pages, not just api routes. At pilot with one customer it looks like "the whole site went down" instead of "chat send was briefly slow". Scales linearly with deploy frequency.

**Fix.** Decouple web's liveness signal from api. Add a `/api/health/web` route on Next.js that probes ONLY Postgres + process uptime (no api fetch), and point Caddy's default-block `health_uri` + the web container's HEALTHCHECK at that. Keep `/api/health` as the operator-facing deep probe for HEALTHCHECK_URL (which SHOULD couple, since the product is broken without api). One-file change in apps/web/src/app/api/health-web/route.ts + 2 lines each in Caddyfile.template + docker-compose.yml/Dockerfile.

**Verifier note.** Verified the cited code:

1. **Caddyfile.template:215** — `health_uri /api/health` on the default block (web upstream). Confirmed. With `health_interval 2s` and `health_status 200`, Caddy marks the web upstream unhealthy after a single failed probe, returning 502 for `/`, `/login`, `/_next/*`, `/api/auth/*`.

2. **apps/web/src/app/api/health/route.ts:65-83** — confirmed: returns 503 if either DB or api probe fails. The api probe calls `http://api:4000/health` (NestJS); during api drain or restart this fails fast (ECONNREFUSED).

3. **docker-compose.yml:252** — confirmed: web's Docker HEALTHCHECK consults the same `/api/health` deep probe.

4. **docker-compose.yml:441** — `stop_grace_period: 100s` on api, plus 120s `start_period` (for `prisma migrate deploy`). So api can be unreachable for 100s+ during a graceful restart, well past Caddy's 5s `lb_try_duration` retry budget.

**Failure mode IS reachable**: During an api-only restart (or crash, or api-only deploy), web upstream is marked unhealthy and Caddy returns 502 for every default-block path including `/login` and static assets — even though Next.js itself is up.

**Is it locked/intentional?** The route.ts header comment explicitly defends the Docker HEALTHCHECK coupling as intentional: "Without the api probe, an api or Redis outage left `docker compose ps` reporting `web: healthy` while chat was completely broken, masking the outage for operators." That's the OPERATOR-VISIBILITY design choice. It does NOT defend using the same deep probe for Caddy's upstream routing — those are two different concerns.

**Severity**: Medium is appropriate. At pilot scale (1 customer) this bites every api-only deploy with a 30s–2min 502 window on login/marketing pages. Not customer-data-loss, not a security hole — but a real avoidable outage surface during routine ops.

**Proposed fix critique**: The finder is right to decouple Caddy's `health_uri` from the deep probe — a shallow `/api/health/web` (just process + db) would let Caddy keep routing static + login traffic through web while api is bouncing. BUT the finder also proposes pointing the Docker HEALTHCHECK at the shallow probe, which would directly revert the intentional operator-visibility design. The HEALTHCHECK should stay on the deep `/api/health` (or operators should use the api's own `/health` for direct probing). So the fix is half-right.

Net: finding stands but the fix proposal needs adjustment — only the Caddy `health_uri` should be decoupled, not the Docker HEALTHCHECK.


## M12. `Wait for health` 60s budget can auto-rollback a healthy deploy whose migration is still running
_Deployment / production / docker / migrations_ · `.github/workflows/deploy.yml:617-626 (60s health window) vs docker-compose.yml:420 (api start_period: 120s)`

**Problem.** After ship, `.github/workflows/deploy.yml:617-626` polls HEALTHCHECK_URL for 30 × 2s = 60s. But `docker compose up -d` is async, then api runs `pnpm prisma migrate deploy` (compose api start_period is 120s precisely because a fresh-DB or stack-of-migrations deploy can take 30-90s+ to apply), THEN exec's node, THEN web's healthcheck (which depends on api per finding #1) flips green, THEN Caddy's health probe flips green. On a deploy with a non-trivial schema migration, the 60s window will routinely expire before HEALTHCHECK_URL passes.

**Why dangerous.** When that timeout trips, `Auto-rollback on health failure` (deploy.yml:689-724) retags `:previous-*` → `:latest-*` and recreates the stack — but the migration ALREADY succeeded on the live Postgres. The old code now runs against the new schema. Prisma's generated client is version-pinned and will throw on dropped columns / new required fields the old code doesn't know about. The auto-rollback that's supposed to save a bad deploy actually CREATES a hard outage.

**Impact.** Any non-trivial migration deploy at pilot time risks a phantom-rollback into a broken state, requiring manual intervention to forward-fix. Probability rises sharply with migration size.

**Fix.** (1) Raise the health-wait budget to match api start_period — `seq 1 60` with `sleep 2` = 120s, or better `for i in $(seq 1 90); do ... sleep 2`. (2) Add a guard to skip auto-rollback when the migration has changed the schema — store the `prisma migrate status` before/after in the ship step and refuse rollback if `applied_migrations` differs. (3) Make migrations runtime-backwards-compatible policy explicit so that even if a rollback fires mid-migration, the previous code still works (expand-contract migrations only).

**Verifier note.** Verified at the cited locations:

1. `.github/workflows/deploy.yml:621-626` — `Wait for health` is exactly `seq 1 30` with `sleep 2` = 60s budget. Matches the claim.
2. `docker-compose.yml:398-403` — api container's command is `(cd /app && pnpm prisma migrate deploy) && exec node -r @swc-node/register src/main.ts`. So `up -d` does not return a "healthy" api until migrate completes AND node boots AND healthcheck passes.
3. `docker-compose.yml:413-420` — `start_period: 120s` with an inline comment explicitly stating "a fresh DB's first migration can take 30-60s and a multi-migration deploy against a stale DB can stack longer." The team has already documented the very mismatch this finding describes.
4. `deploy.yml:689-724` — auto-rollback on health failure retags `:previous-{web,api}` → `:latest-*` and recreates the stack, with no guard for "migration has already been applied to live DB". The old image's Prisma client would then run against the migrated schema.

The failure mode is reachable. The 60s health budget is BELOW the documented 120s start_period the team chose precisely because migrations can take that long. On the next non-trivial migration deploy, health-wait will time out before the api flips healthy, triggering auto-rollback against an already-migrated DB. Prisma's generated client is version-pinned to the schema, so the old code throws on any dropped column / new required field — turning a slow-but-successful deploy into a hard outage.

Why I don't downgrade despite mitigating factors:
- The team has SQUASHED migrations to a single `0_init` (per memory), so the no-op fast path is reliable — but each new migration since (3 in the last few days per `ls`) is exactly the case that hits the cliff.
- The blast radius on a trigger is exactly the scenario auto-rollback was meant to prevent (broken site requiring manual intervention).
- This isn't documented in CLAUDE.md as intentional/deferred; the docker-compose comment shows the team knows about migration timing but didn't connect it to the deploy.yml budget.
- Not flagged in any prior audit memory.

I would not promote it to High because: (a) at pilot with small schema, most migrations apply in well under 30s; (b) the fix (raise the budget to 120s+) is trivially safe — extending the window only delays the rollback for healthy slow-starts, never causes a worse failure than the current behavior; (c) trigger requires both a schema-changing PR AND slow migration, so probability per arbitrary deploy is low.

Severity Medium is right: not an immediate user-visible bug, but a self-inflicted outage waiting for the right migration size to ship.

Cited code is at /home/aliubuntu/projects/loadless_projects/customer-communication-platform/.github/workflows/deploy.yml:616-626 and /home/aliubuntu/projects/loadless_projects/customer-communication-platform/docker-compose.yml:398-420 — finding is accurate.


## M13. Outbound-webhook enrichment failure drops every delivery for that publish
_Integrations / inbound + outbound webhooks / API keys_ · `apps/api/src/outbound-webhooks/outbound-webhooks.subscriber.ts:176-185 (handle() awaits enrichMessages/enrichSentMessageContext/hydrateUsers/resolveChannel without per-call isolation)`

**Problem.** OutboundWebhooksSubscriber.handle awaits enrichMessages, enrichSentMessageContext, hydrateUsers, and resolveChannel BEFORE entering the per-webhook delivery loop, with no try/catch around any of them. A single rejected Prisma findMany (pool flap, lock-wait timeout, transient PG hiccup, malformed cached row) propagates out of handle(); the outer subscribe wrapper at lines 86-95 catches it and logs, but by then ZERO OutboundWebhookDelivery rows have been written for this event. The doc comment on those helpers says 'Best-effort: a failed lookup leaves the documented null in place rather than dropping the delivery' — the code does the opposite.

**Why dangerous.** There is no replay layer for the bus → outbound-webhook fanout (unlike workflow runs, which persist + retry). Once handle() throws, the message.received / message.sent / contact.tag_changed event is lost to every subscribed partner forever. The DB row that triggered it is committed, the user-facing socket frame already fanned out, but the integration silently misses the event. Pool pressure during a peak inbound burst would correlate-fail the enrichments AND the delivery writes together, so this isn't just a tail-risk class.

**Impact.** Customer-visible: an n8n flow that 'should fire on every inbound' silently skips some inbounds during DB pressure with no surface signal — no failed delivery, no log line a customer can see, no retry. A pilot integration debugging 'why didn't this trigger?' has nothing to point at.

**Fix.** Wrap each enrichment in try/catch and degrade-on-failure (the lookups already document null defaults — let them stand). Concrete: `try { await this.enrichMessages(envelopes); } catch (err) { this.logger.warn("enrichMessages failed; delivering un-enriched", err); }` per helper, plus the resolveChannel call. The delivery loop already tolerates `channelBase=null`. This restores the documented best-effort posture and ensures a row-write per matching webhook even when one enrichment query throws.

**Verifier note.** Verified the finding against the actual code at apps/api/src/outbound-webhooks/outbound-webhooks.subscriber.ts:176-185. The finder's claim is precise:

1. Lines 176-185 do show `await this.enrichMessages(envelopes)`, `await this.enrichSentMessageContext(envelopes)`, `await this.hydrateUsers(envelopes)`, and `await this.resolveChannel(...)` called sequentially with no per-call try/catch.

2. The code comment at lines 169-175 explicitly documents the intended contract: "Best-effort: a failed lookup leaves the documented `null` in place rather than dropping the delivery." The code violates this contract — any throw propagates to handle(), gets caught by the outer wrapper at lines 86-95, but by then ZERO OutboundWebhookDelivery rows have been created for this event because the delivery loop at lines 187-262 hasn't been reached yet.

3. No replay layer for bus subscribers — confirmed by inspecting the structure. The BullMQ delivery worker retries the HTTP POST, not the enrichment step. Lost = lost.

4. This sits in the exact same code path the memory log says was hardened for "two-layer error isolation" (per-webhook + per-envelope try/catch). The hardening stopped at the delivery loop and did NOT cover the enrichment phase — a real gap in the same effort.

5. The proposed fix is concretely safer: line 199 already passes `channelBase` which can be null (the delivery loop tolerates it), and the enrichments already document null defaults. Wrapping each await in try/catch with a warn-log matches the stated contract without introducing a new failure mode.

6. Severity: Medium is appropriate. Not Critical (no data loss for the conversation itself, no security implication, pilot has few partner integrations), but not Low (silent event loss with no customer-visible signal contradicting documented best-effort contract is a real correctness gap that bites under DB pressure). Confidence high.

Finding stands as Medium with the proposed fix.


## M14. /v1 contact/conversation mutations don't propagate X-CCP-Depth — partner webhook → /v1 loop possible
_REST API surface_ · `apps/api/src/external/v1/external-v1.controller.ts:193-263 (createContact / upsertContact / updateContact / deleteContact), :276-335 (addContactTags / removeContactTag / removeContactTags), :454-516 (assign / setStatus / assignByContact / setStatusByContact)`

**Problem.** ExternalV1Controller wires `parseChainDepth(xCcpDepth)` only on the routes that send/note/bulk-tag — sendMessage, sendTopLevelMessage, createNote, bulkAddTags, bulkRemoveTags. The CONTACT mutation routes (POST /v1/contacts, POST /v1/contacts/upsert, PATCH /v1/contacts/:id, POST /v1/contacts/:id/tags, DELETE /v1/contacts/:id/tags/:tagId, POST /v1/contacts/:id/tags/remove) AND the conversation mutation routes (POST /v1/conversations/:id/assign, POST /v1/conversations/:id/status, POST /v1/contacts/:id/assign, POST /v1/contacts/:id/status) accept NO X-CCP-Depth header and pass no chainDepth to the service. Each of these mutations publishes a domain event (`contact.updated`, `contact.tag_changed`, `conversation.assigned`, `conversation.status_changed`) that the outbound-webhook subscriber delivers to partners.

**Why dangerous.** A partner whose receiver responds to e.g. `contact.tag_changed` by calling PATCH /v1/contacts/:id (or POST /v1/contacts/:id/tags) creates a hot loop: tag → webhook → partner → /v1 mutation → tag → webhook → … The MAX_CHAIN_DEPTH gate exists exactly to break this, and it works for sends/notes/bulk-tag, but per-contact and per-conversation mutations are uncovered. Only the per-key 60/min rate limiter eventually throttles the storm — until then partners can melt the worker + burn the team's webhook quota.

**Impact.** Pilot blast radius: any partner that wires both an outbound webhook AND an automation calling /v1 contact/conversation mutations (the explicit n8n use case the routes are built for) can self-DoS the team's webhook fanout. Outbound deliveries pile up, the workflow worker chases its tail, and other teams sharing the BullMQ workers see queue lag. Probability rises with adoption.

**Fix.** Mirror the pattern already used by `bulkAddTags` and `sendMessage`: add `@Headers("x-ccp-depth") xCcpDepth?: string` to each mutating route and pass `parseChainDepth(xCcpDepth)` through ExternalV1Service into ExternalV1MessagingService. The service-side gate is already in place (`if (chainDepth >= MAX_CHAIN_DEPTH) drop`) — only the controller-side wiring is missing. While there, add the same outbound-webhook worker stamp (X-CCP-Depth on deliveries) so the partner can forward the depth back symmetric to send/note paths.

**Verifier note.** The factual claim is correct: I independently verified that `apps/api/src/external/v1/external-v1.controller.ts` only wires `parseChainDepth(xCcpDepth)` on bulkAddTags/bulkRemoveTags (160-188), sendTopLevelMessage (535-545), sendMessage (581-591), and createNote (604-613). The contact/conversation mutation routes — createContact, upsertContact, updateContact, deleteContact, addContactTags, removeContactTag, removeContactTags, assign, setStatus, assignByContact, setStatusByContact — accept no `X-CCP-Depth` header and pass nothing to the service. Confirmed via `packages/shared/src/outbound-webhooks/public-events.ts:836-851` that `contact.updated`, `contact.tag_changed`, `conversation.assigned`, `conversation.status_changed` ARE on the outbound-webhook allowlist, so a partner-receiver does see these events and could call back to /v1.

However, the "High" severity claim is overstated for three reasons:

1) The outbound-webhook delivery worker (`apps/api/src/lib/outbound-webhooks/worker.ts:319-341`) does NOT stamp `X-CCP-Depth` on outgoing deliveries. It only stamps `X-CCP-Origin-Key` and a comment at lines 306-314 explicitly calls out this header as THE loop-break for "partner → POST /v1/messages → our message.sent → outbound webhook → partner → POST again, ad nauseam." That defense is already uniformly applied to contact/conversation mutations via `extractOriginApiKeyId` (worker.ts:610-628) which reads `changedByApiKeyId` from the flat wire shape. So the partner-webhook → /v1 loop class is mitigated for ALL routes by `X-CCP-Origin-Key` + the partner's "if origin matches my key, ignore" check — not by `X-CCP-Depth`. The existing `X-CCP-Depth` guard is symmetric with the workflow `http_request` step (which DOES stamp the header), not partner deliveries.

2) For the workflow http_request → partner → /v1 loop class (the scenario X-CCP-Depth actually addresses), `ApiKeyGuard` already caps each key at 60 req/min hard (api-key.guard.ts:38-41) — saturating at ~1 mutation/sec, not "melt the worker / burn the team's webhook quota." The controller's default `@RateLimit({ perMinute: 600 })` and per-team workflow concurrency add further bounds.

3) `workflow-dispatch.ts:73-118` resets the depth chain on every event-triggered workflow dispatch (no chainDepth threaded into `dispatch()` for assigned/status_changed/contact.updated), so even if the unguarded /v1 routes did honor X-CCP-Depth, an event-bus-mediated loop would reset to 0 each iteration anyway. The chain-depth guard's coverage of partner-loops via these events is already imperfect by design — extending controller wiring without also threading depth into `dispatch()` adds only marginal protection.

The gap is real (the uniformity of the guard would be better than spotty coverage, and the fix is trivial: copy the @Headers + parseChainDepth pattern), but the failure mode is bounded by multiple existing layers and is closer to a Medium defense-in-depth consistency cleanup than a "partner can self-DoS the team" High. The proposed fix is safe and concrete; agree with implementing it, but at Medium priority.


## M15. sendInteractive has no pre-Meta idempotency — agent double-click can produce two outbound rows
_REST API surface_ · `apps/api/src/messages/messages.controller.ts:133-140 (route), apps/api/src/messages/messages.service.ts:2088-2153 (sendInteractive body — no runWithSendIdempotency), apps/api/src/messages/messages.schemas.ts:33-67 (SendInteractiveSchema — no clientTempId)`

**Problem.** POST /api/messages/interactive (MessagesController.sendInteractive) bypasses `runWithSendIdempotency` and the OutboundSendAttempt-by-jobId pre-Meta lock that text/media/template sends use. The Zod schema (`SendInteractiveSchema`) does not even accept `clientTempId`, and `sendInteractiveInternal` only dedupes AFTER Meta returns a wamid via `createOutboundMessageIdempotent` (which keys on the externalId Meta assigned). A double-clicked Send button (or a browser auto-retry of a 5xx) fires two parallel sendInteractive → two parallel Meta API calls → two distinct externalIds → two distinct DB rows + two `message.sent` events.

**Why dangerous.** Synchronous handlers without a pre-Meta dedupe key can't be made retry-safe. The text/media/template send paths solve this with `runWithSendIdempotency` (keyed on userId+conversationId+clientTempId) PLUS BullMQ jobId; sendInteractive has neither. Customer sees a duplicate buttons/list bubble; workflows watching `message.sent` re-fire; the agent's quality rating takes a small hit.

**Impact.** Limited blast radius — interactive sends are documented as rare in the source comment. But the ask_question workflow step calls `sendInteractiveInternal` too, so a worker retry on a network glitch could double-send there as well. Most-visible failure mode: a customer sees two identical button cards.

**Fix.** Add `clientTempId: z.string().min(1).optional()` to SendInteractiveSchema. Wrap the body of `sendInteractive` in `runWithSendIdempotency({ teamId, userId, conversationId: input.conversationId, clientTempId: input.clientTempId }, () => this.sendInteractiveInner(...))` — same wrapper sendText/sendTemplate use a few lines above in the same file. The frontend buttons/list composer also needs to stamp a fresh UUID per Send click, mirroring the text composer.

**Verifier note.** Verified all claims against the code:

1. **Schema (apps/api/src/messages/messages.schemas.ts:33-67)**: `SendInteractiveSchema` confirmed — no `clientTempId` field. SendTextSchema (line 6) and SendTemplateSchema (line 20) both have it.

2. **Controller (apps/api/src/messages/messages.controller.ts:133-140)**: confirmed — bare `messages.sendInteractive(teamId, userId, body)` with no idempotency wrapper.

3. **Service (apps/api/src/messages/messages.service.ts:2088-2153)**: confirmed — no `runWithSendIdempotency`. Compare to sendText line 405 and sendTemplate which both wrap their bodies with it.

4. **Internal sender (apps/api/src/lib/messaging/send-interactive-internal.ts:145)**: confirmed Meta API call happens BEFORE any dedupe. The only dedupe is `createOutboundMessageIdempotent` at line 167, which is keyed on `send.externalId` — Meta returns a fresh `wamid` on each call, so two parallel calls produce two different externalIds and both rows persist. There is no OutboundSendAttempt pre-Meta lock either.

5. **Workflow exposure is real**: `ask_question` step (apps/api/src/lib/workflows/steps/ask-question.ts:387) calls `sendInteractiveInternal` directly. The workflow queue retries `attempts: 3` (apps/api/src/lib/workflows/queue.ts:91). If Meta send succeeds but the post-send transaction in send-interactive-internal.ts:215 fails (lock conflict, connection blip), the retry re-enters and re-calls Meta. The text/template paths are protected by `runWithSendIdempotency` + BullMQ jobId on `enqueueMessageSend`; the interactive path skipped both layers.

6. **Frontend double-click is partially guarded** by the `busy` flag in interactive-popover.tsx:124, but the primary danger isn't browser double-click — it's (a) parallel sends from two tabs and (b) the workflow worker retry path, both of which the busy flag can't see.

7. **Not listed as deferred/locked** in CLAUDE.md or memory.

Severity "Medium" is correct: the most common UI vector is partially guarded, but the workflow retry path is fully unguarded and would silently double-send button cards to customers + double-fire downstream `message.sent` subscribers (workflow triggers, outbound webhooks, audit). The fix is small and mirrors the proven text/template pattern.

Proposed fix is safe: adding `clientTempId` to the schema + wrapping in `runWithSendIdempotency` is identical to the working text/template paths; no new failure mode introduced.


## M16. GET /api/broadcasts and GET /api/team/workflows/:id/runs are hard-capped without pagination — older history is unreachable
_REST API surface_ · `apps/api/src/broadcasts/broadcasts.service.ts:359 (broadcast list — hardcoded `take: 100` with no cursor), apps/api/src/team/workflows/workflows.service.ts:872 (`take: 50` with no cursor); request schemas at apps/api/src/broadcasts/broadcasts.schemas.ts:77-83 and a missing schema for workflow runs`

**Problem.** Two list endpoints return only the newest N rows with NO cursor/take parameter and no `hasMore` signal: `BroadcastsService.list` returns the newest 100 broadcasts (apps/api/src/broadcasts/broadcasts.service.ts:359-394, `take: 100`) and `WorkflowsService.listRuns` returns the newest 50 runs (apps/api/src/team/workflows/workflows.service.ts:872-895, `take: 50`). `BroadcastListQuerySchema` only supports status + search filters; neither route accepts a cursor.

**Why dangerous.** Once a team accumulates >100 broadcasts (or >50 runs on a chatty workflow), the older entries are permanently invisible. The pilot customer running a few broadcasts/day hits 100 in ~a month; an active automation hits 50 runs in hours. Without `recipientsTruncated`-style markers the UI can't even tell the user it's truncated, so the broadcast history simply appears to silently lose old runs.

**Impact.** User-visible "history disappears" surprise once usage scales. Auditing a delivery from 4 months ago is impossible. For the workflow runs the impact bites faster — a debugging session for a workflow that fires once an hour can't see yesterday's runs.

**Fix.** Extend `BroadcastListQuerySchema` with `cursor: z.string().optional()` + `take: takeQuery` (already defined in `conversations.schemas.ts`); convert `BroadcastsService.list` to keyset pagination on `(createdAt DESC, id DESC)` returning `{ broadcasts, nextCursor }`. Add the same to `listRuns` (orderBy `(startedAt DESC, id DESC)`). The list-endpoint envelope across the codebase isn't standardized — adopting `{ items, nextCursor }` here matches the inbox-search/attachments shape already in use.

**Verifier note.** Both citations independently verified:

1. `apps/api/src/broadcasts/broadcasts.service.ts:371-376` — `BroadcastsService.list` does `findMany({ where, orderBy: { createdAt: "desc" }, take: 100, ... })` with no cursor parameter and returns a bare `rows.map(...)` array — no `hasMore`, no `nextCursor`.

2. `apps/api/src/team/workflows/workflows.service.ts:879-895` — `WorkflowsService.listRuns` does `findMany({ where: { workflowId: id }, orderBy: { startedAt: "desc" }, take: 50, ... })` returning `{ runs: [...] }` with no truncation marker. The controller at `workflows.controller.ts:118-123` accepts ZERO query params.

3. `apps/api/src/broadcasts/broadcasts.schemas.ts:77-83` — `BroadcastListQuerySchema` only has `status` and `search`. No `cursor`, no `take`.

4. Frontend `apps/web/src/app/(app)/broadcasts/broadcasts-browser.tsx` calls `/api/broadcasts?...` and just `setRows(body.broadcasts)` — no load-more, no infinite scroll, no signal that older entries exist.

Failure mode is reachable as described: once a team accumulates >100 broadcasts or >50 runs on a workflow, older entries are unreachable through the API and the UI cannot communicate the truncation. Workflow runs in particular fill 50 fast for any hourly automation — debugging yesterday's runs becomes impossible.

Not deferred in CLAUDE.md or MEMORY (checked both — only the broadcast detail page's `RECIPIENTS_INLINE_CAP = 500` has documented rationale with a `?cursor=` follow-up route; list endpoints have no such escape hatch).

Severity Medium is correctly calibrated:
- Not a production blocker at pilot (1 customer, low volume)
- Will bite within weeks-to-months as usage grows (workflow runs sooner)
- No data loss (rows still exist in DB; just unreachable via API)
- Fix is mechanical and matches existing `{ items, nextCursor }` shape used by inbox-search/attachments

Proposed fix is sound and doesn't introduce regressions: keyset pagination on `(createdAt DESC, id DESC)` is the standard pattern, matches what other list endpoints in this codebase already use, and the schema extension via `takeQuery` from `conversations.schemas.ts` is a real reusable type.


## M17. Outbox drainer parallel dispatch is unbounded — comment claims concurrency:8 but code does Promise.all over all 200 rows
_Realtime / Socket.io / bus_ · `apps/api/src/events/outbox-drainer.service.ts:173 — `Promise.all(rows.map((row) => this.dispatch(row).catch(...)))``

**Problem.** OutboxDrainerService.tick() calls `Promise.all(rows.map((row) => this.dispatch(row)...))` with BATCH_SIZE=200 rows. The comment block at line 135-142 explicitly says "Concurrency:8 mirrors the outbound-webhook lane fan and keeps any one team's events from monopolizing", but the actual code uses unbounded `Promise.all` — there is no `runWithConcurrency` / pLimit / `p-queue` wrapper. Every row's subscriber chain (audit + analytics + workflow-dispatch + outbound-webhooks) runs in parallel, each performing 3-6 DB queries (audit reads stage/tag names + writes a row; analytics writes the conversation row; workflow-dispatch reads a fresh conv snapshot + does workflow.findMany + dispatch(); outbound-webhooks does findMany + N delivery inserts). A full 200-row batch can momentarily demand 600-1200 simultaneous DB queries against a Postgres pool of max=50.

**Why dangerous.** Under sustained burst (large webhook batch from Meta — 10 inbounds × ~3 events each = ~30+ rows per second; broadcast finalization writing 1k+ rows; bulk contact import) the `connectionTimeoutMillis: 5_000` will fire on starved-pool acquisitions. Subscriber chains time out, throw, and `markPublishedWithError` stamps the outbox row — but the row is already marked `publishedAt` (at-most-once), so audit/analytics/outbound-webhook writes for those events are SILENTLY LOST. Worse, the realtime emit was fired-and-forgotten at startIdx=0 so the wire frame DID land — the inbox UI looks correct, but the partner integrations / audit log / analytics counters silently lose entries. The error trail goes to `OutboundEvent.lastError` (queryable) and stdout, but operators will not notice until a tagged-bulk-update doesn't show in webhook deliveries.

**Impact.** User-visible only at scale: at pilot one tenant likely never hits 200-row bursts. Bites in the few-tenants-with-bursts band: a 1k-recipient broadcast's finalization produces a synthetic burst (status_changed → completed); a 500-contact bulk-tag publishes 500 `contact.updated` (suppressSocketFanout) + 500 `contact.tag_changed` = 1000 rows in seconds. Outbound-webhook customers will report missing events; audit timeline gaps will appear; analytics counters will drift low.

**Fix.** Wrap the dispatch fan with a bounded-concurrency primitive matching the comment's intent. The codebase already has `runWithConcurrency` in `apps/api/src/common/concurrency.ts` (used by OutboundWebhooksSubscriber, confirmed at outbound-webhooks.subscriber.ts:21). Replace the unbounded `Promise.all(rows.map(...))` with `await runWithConcurrency(rows, 8, (row) => this.dispatch(row).catch(...))`. Concurrency=8 matches the outbound-webhook lane fan AND fits comfortably inside pool max=50 with headroom for parallel HTTP requests + sweepers. Update the comment to reflect actual concurrency. Optionally, also reduce BATCH_SIZE to 100 (since lanes=8 means most rows queue anyway) or keep at 200 and accept the per-tick wall time.

**Verifier note.** Verified at /home/aliubuntu/projects/loadless_projects/customer-communication-platform/apps/api/src/events/outbox-drainer.service.ts:173 — code is exactly `Promise.all(rows.map((row) => this.dispatch(row).catch(...)))` with BATCH_SIZE=200 (line 65). The comment block at lines 135-142 explicitly claims "Concurrency:8 mirrors the outbound-webhook lane fan and keeps any one team's events from monopolizing" — but the code does NOT enforce concurrency:8. This is a clear comment-vs-code drift: git blame shows commit cd90a79 (2026-05-29 "audit") moved from sequential `for...await` to `Promise.all` and added the concurrency-claiming comment without wiring `runWithConcurrency`.

`runWithConcurrency` exists at apps/api/src/common/concurrency.ts and is the established pattern: outbound-webhooks.subscriber.ts:224 uses `runWithConcurrency(matching, 8, ...)`; contacts/conversations/external-v1 services use it at 16; meta.controller at 4. The fix the finder proposes is the right pattern, already in-tree.

Pool config confirmed at apps/api/src/db/db.service.ts:60 (max=50, connectionTimeoutMillis=5_000).

CORRECTION on impact magnitude: the finder claims each row's subscriber chain runs 3-6 parallel DB queries, yielding 600-1200 simultaneous. That's wrong — apps/api/src/lib/events/bus.ts:261-273 shows subscribers AFTER the realtime tier run in a SEQUENTIAL `for...await` loop. At any instant, one row holds ~1 DB connection (not 3-6). So peak demand for a 200-row batch is ~200 simultaneous connections, not 600-1200. Still 4× pool max=50, still a real cliff under bursts, but the math the finder cites is inflated.

Reachability: realistic burst sources exist — broadcast finalization (1k-recipient status_changed + completed), bulk-tag (500 contacts × 2 events = 1000 rows). At pilot/1-customer scale these are rare-but-real. The failure mode the finder describes is correct: claimBatch already stamps `publishedAt` (at-most-once), so a subscriber starved on pool-acquire will throw, audit/analytics/outbound-webhook writes silently lost, only `lastError` queryable on the row. The realtime emit at startIdx=0 in bus.ts:229-253 is fire-and-forget so the UI still looks correct.

Memory check: the 2026-05-29 12-agent audit shipped (per project_predeploy_p1_fixes_2026_05_26 memory) explicitly bounded outbound-webhooks at 8 lanes and added drainer subscriber-error capture, but did NOT bound the drainer's own row-level fan. This isn't listed as intentional/deferred anywhere — it's a gap from that very pass. The comment is documentation of the INTENDED bound, not a deferred decision.

Severity: Medium is right. Not Critical (latent at 1 customer, no chat-path data loss because realtime emit is fire-and-forget pre-await), not Low (the silent-loss-after-publishedAt path IS the worst class of failure for an outbox system, and the comment-vs-code drift hides it). The proposed fix (`runWithConcurrency(rows, 8, ...)`) is strictly safer than current code and matches documented intent.


## M18. ContactPanel mirrors thread state with parallel writers (single-ownership violation)
_State management_ · `apps/web/src/features/inbox/components/contact-panel.tsx:180-247`

**Problem.** ContactPanel maintains its own `liveStatus` / `liveMessageCount` / `liveNoteCount` / `assigneeId` state by subscribing directly to `conversation:status`, `message:new`, `note:new`, `note:deleted`, and `conversation:assigned` (apps/web/src/features/inbox/components/contact-panel.tsx:180-247). The same events are reduced by `useConversationEvents` into `data` (per THREAD_REDUCER_EVENTS in thread-reducers.ts), and the rest of the inbox is documented as having a single source of truth. The panel exists because inbox-shell deliberately does NOT bump `cacheTick` on cache patches (inbox-shell.tsx:803-812), so the prop `data` handed to ContactPanel is the SSR/last-fetch snapshot rather than the live-patched cache; ContactPanel works around that by listening manually.

**Why dangerous.** Two parallel writers for the same logical state. Any future field added to the thread reducer (or new event) must be wired in FOUR places now (reducer + live-hook handler + shell handler + ContactPanel listener), not three. The CLAUDE.md "Realtime cache patch matrix" rule only documents the three. The cost is also runtime: every event for a displayed conversation runs through TWO listener paths (live hook + ContactPanel) plus the iterated reducer set, all firing setState.

**Impact.** Recurring missed-wiring bug class. The user shipped multiple fixes already (`liveStatus`, then `liveMessageCount`, then `assigneeId`) — each addition is a manual re-wire that has to remember which events flip which field. As long as the panel mirrors a subset, new fields can land that miss it. Cosmetic for now, but matches exactly the "stuck/stale per-thread state at decision-tree time" CLAUDE.md flags.

**Fix.** Either (a) bump `cacheTick` (or a separate `displayedThreadVersion` counter) on `patchData` for the currently-displayed id in inbox-shell.tsx so a normal re-render hands ContactPanel the live `data`, OR (b) lift the displayed thread's live state into a context above MessageThread + ContactPanel (a sibling provider in ThreadWorkspace) so both consume the same hook output. Either lets ContactPanel render straight from `data.conversation.status` / `data.messageCount` / `data.assignedUser?.id` and the four duplicated listeners + their conversation-switch resync effect (lines 180-247) go away.

**Verifier note.** Independently verified at the cited location.

(1) Code matches the claim. apps/web/src/features/inbox/components/contact-panel.tsx:170-247 does maintain `liveStatus`/`liveMessageCount`/`liveNoteCount` (and at line 278 `assigneeId`) by subscribing directly to `conversation:status`, `message:new`, `note:new`, `note:deleted`, and `conversation:assigned`. The conversation-switch resync effect at lines 194-199 also matches.

(2) Sibling-not-child architecture confirmed: `ThreadWorkspace` in apps/web/src/features/inbox/components/inbox-shell.tsx:1108-1149 renders `MessageThread` and `ContactPanel` as siblings, both receiving the same `thread.data` snapshot. MessageThread is the only consumer of `useConversationEvents` (apps/web/src/features/inbox/components/message-thread.tsx:147). So ContactPanel's `data` prop is structurally frozen at last server snapshot / cache write.

(3) Silent cache patch confirmed at inbox-shell.tsx:807-812: `handleThreadSnapshot` calls `cache.patch(...)` with no `cacheTick` bump, and the in-line comment explicitly says "writes silently (no cacheTick bump)". So the displayed thread re-render is not driven from `data` — only from MessageThread's own state and ContactPanel's own listeners.

(4) The comment block at contact-panel.tsx:170-179 acknowledges the tradeoff explicitly ("Two listeners for the same events is cheap; the alternative would be lifting the hook into a shared parent, which is a much larger refactor for this one panel"). So this is a known, documented intentional choice — not a bug — but it IS the parallel-writer pattern the finder describes. CLAUDE.md's "Realtime cache patch matrix" rule lists thread-reducers + use-conversation-events + inbox-shell.tsx — ContactPanel's listeners are NOT in that rule, so a future field-add risks missing this fourth site (exactly the failure mode named).

(5) Severity Medium is appropriate per the project's severity guide ("correctness/maintainability problem, not user-visible yet"). No current bug, no perf cliff (handful of conditional setStates per event), no data loss — but it is a recurring missed-wiring trap. The finder isn't overstating: they're calling it Medium, flagging the bug class without claiming a live failure.

(6) Not on any "intentional/locked/deferred" list in CLAUDE.md or MEMORY.md. The closest items (`optimistic_socket_dispatch`, "Realtime cache patch matrix") actually reinforce the finding — they tell future authors there are 3 wiring sites for per-thread state, not 4.

(7) Proposed fixes are not worse than the current code. Fix (a) — bumping `cacheTick` for the displayed id — would cause re-renders the existing comment was trying to avoid, but ContactPanel is already memoized (line 1364) and would update via fresh `data` props anyway. Fix (b) — lifting state — is a real refactor as the in-code comment already concedes. Neither introduces a new failure mode.

Verdict: finding stands at Medium. Real architectural duplication, real future-bug surface, no live failure today. Severity unchanged.


## M19. ask_question saveTo never publishes contact.updated — realtime/analytics/audit/outbound-webhooks all miss the write
_Workflows / automations / triggers_ · `apps/api/src/lib/workflows/steps/ask-question.ts:312-329`

**Problem.** After writing the answer into `Contact.customFields`, ask_question returns without publishing any DomainEvent. update-field.ts (its sibling) publishes `contact.updated` with `fieldChanges: [...]` so realtime fanout updates the inbox panel live, the audit subscriber writes the timeline pill, the analytics subscriber updates any denormalized fields, and outbound webhooks fire the `contact.field_updated` partner event. ask_question's saveTo skips all of that.

**Why dangerous.** The contact panel in any open inbox session shows stale data until the user clicks away and back. The audit timeline has no record that the workflow set the field. Partners subscribed to `contact.field_updated` to sync answers into their CRM never see workflow-collected answers — only manually-edited ones — so the answer is silently siloed in our DB.

**Impact.** Every workflow that uses ask_question saveTo as a data-collection mechanism (chat-survey, quote intake, scheduling intake) is invisible to the partner CRM. Manual edits show up; the entire ask_question funnel does not. Hard to notice until a customer asks "why did your bot collect the address but our HubSpot doesn't have it?"

**Fix.** After the `db.contact.update`, publish `contact.updated` with the same shape update-field.ts uses (line 152-161 there): fieldChanges entry, previousStageId unchanged, silent:true, workflowContact snapshot. Re-use `workflowContactSnapshot` from lib/workflows/events.ts. The fresh-read added in the prior finding gives you the previous value to put in `fieldChanges[].previous`.

**Verifier note.** Independently verified the cited code at /home/aliubuntu/projects/loadless_projects/customer-communication-platform/apps/api/src/lib/workflows/steps/ask-question.ts:312-329. The ask_question handler does call `db.contact.update` to mutate `Contact.customFields` and returns immediately with no `publish()` call. Compared with the sibling pattern at apps/api/src/lib/workflows/steps/update-field.ts:152-161 which publishes `contact.updated` with `fieldChanges` (silent:true), the gap is real.

The finder's claim breaks down on independent verification as follows:

CORRECT parts of the finding:
1. Realtime fanout: apps/api/src/realtime/fanout-rules.ts:181 maps `contact.updated` → `contact:updated` socket emit to the team room. ask_question saveTo's missing publish does leave any open inbox contact panel showing stale customFields until a manual refetch/chat-switch.
2. Outbound webhooks: packages/shared/src/outbound-webhooks/public-events.ts:715-733 maps `contact.updated` to the public `contact.updated` envelope carrying `field_changes`. Partners with webhook subscriptions miss workflow-collected answers — manual edits arrive, ask_question answers don't. This is the most concrete leak.
3. Workflow chain dispatch via `contact_field_updated` trigger (apps/api/src/lib/events/subscribers/workflow-dispatch.ts:122-154) — though `silent:true` (which update-field.ts uses) explicitly suppresses this path, so the comparison isn't quite apples-to-apples; suppressing chain dispatch is actually desired for workflow-driven writes.

INCORRECT parts of the finding:
1. The "audit subscriber writes the timeline pill" claim is FALSE. apps/api/src/lib/events/subscribers/audit.ts subscribes to `contact.lifecycle_changed` and `contact.tag_changed` but NOT to `contact.updated` with `fieldChanges` — so even update-field.ts (the comparison reference) does not produce an audit timeline row for a custom-field write. There is no missing pill here.
2. The finder names the wire event `contact.field_updated` — that event type does not exist. The wire shape is `contact.updated` carrying `field_changes`. Functional claim survives, but the name is wrong.

Severity assessment: "High" is overstated. The biggest concrete blast radius is partner CRM sync via outbound webhooks, which is real but bounded — workflows is an active depth workstream and partner integrations are still pre-pilot (no production customer has external webhooks subscribed today). Inbox stale panel is recoverable on chat-switch via the existing reconnect/refetch convergence rules. There is no data loss (the value IS persisted), no security implication, no perf cliff. This is a correctness/completeness gap, not a production-blocking failure. Medium is the right tier.

The proposed fix is safe: publishing `contact.updated` with `silent:true` matching update-field.ts's shape avoids re-triggering the same workflow run (silent suppresses workflow dispatch by design) while restoring realtime fanout and outbound webhook delivery. The fix correctly identifies `workflowContactSnapshot` from lib/workflows/events.ts as the helper to use.

Note that ask_question's saveTo does NOT do a CAS on `version` (which update-field.ts does), so a strict copy of the publish needs the post-update row fetched to populate the snapshot — minor wrinkle in the fix but not a blocker.


## M20. Workflow tag/lifecycle/note steps publish narrow events with silent:true but outbound-webhooks honors silent and skips delivery — comments claim otherwise
_Workflows / automations / triggers_ · `apps/api/src/lib/workflows/steps/tag.ts:149-163, apps/api/src/lib/workflows/steps/update-lifecycle.ts:140-148, apps/api/src/lib/workflows/steps/add-comment.ts:87-99 — vs OutboundWebhooksSubscriber.handle() at apps/api/src/outbound-webhooks/outbound-webhooks.subscriber.ts:141`

**Problem.** tag.ts (contact.tag_changed), update-lifecycle.ts (contact.lifecycle_changed), and add-comment.ts (note.created) all publish with `silent: true`, and OutboundWebhooksSubscriber.handle() short-circuits on `if (event.silent) return;` (outbound-webhooks.subscriber.ts:141). So partners subscribed to those public events NEVER receive step-driven mutations. The in-step comments explicitly document the OPPOSITE intent: tag.ts:147 says "the outbound-webhook subscriber doesn't — partners subscribed to 'On Contact Tag updated' want to see step-driven changes too"; update-lifecycle.ts:135 says the same for stage moves; add-comment.ts:80 says "outbound-webhooks subscriber forwards to integrators". The canonical types.ts:172-186 says silent skips outbound — but if that's the intended behavior, the three step files are publishing a silent-but-otherwise-pointless narrow event for no reason.

**Why dangerous.** Either the silent flag should NOT be set on the narrow events (current outbound-webhook behavior is wrong) or the comments in the step files are misleading (and the narrow event publish is dead code). Either way the gap will surprise the first partner who wires `contact.tag_changed` into their CRM to sync workflow-managed segmentation and notices the partner only ever sees manual tag flips. Same surprise on `note.created` for workflow-authored comments and `contact.lifecycle_changed` for stage moves.

**Impact.** Hits every team running a workflow that mutates contact state for partner-side reaction. The dropped events are exactly the ones partners care about: workflow-driven lifecycle transitions and tag updates ARE the primary integration signal ("contact tag moved to vip → sync to my CRM"). Each partner integration debugged after pilot launch is wall-clock expensive.

**Fix.** Pick one interpretation and unify. The author-intent comments in the three step files want partners to see step-driven changes — drop `silent: true` from the narrow event publishes (keep it on the catch-all `contact.updated` to block workflow-dispatch chain re-entry). If the canonical `silent` semantics in shared/events/types.ts:172-186 are correct (echo-loop avoidance trumps partner visibility), remove the redundant narrow publishes from the three step files entirely and update CLAUDE.md memory to record the decision.

**Verifier note.** Verified the code at every cited location. The claim is accurate on all counts:

1. **Code matches claim:**
   - `apps/api/src/lib/workflows/steps/tag.ts:149-163`: publishes `contact.tag_changed` with `silent: true`, with comment at lines 145-148 explicitly stating "the outbound-webhook subscriber doesn't [read silent] — partners subscribed to 'On Contact Tag updated' want to see step-driven changes too."
   - `apps/api/src/lib/workflows/steps/update-lifecycle.ts:140-148`: publishes `contact.lifecycle_changed` with `silent: true`, with comment at lines 132-136 stating "the outbound-webhook subscriber doesn't read `silent` because partners DO want to know the stage just moved — that's literally why they subscribed."
   - `apps/api/src/lib/workflows/steps/add-comment.ts:87-99`: publishes `note.created` with `silent: true`, comment at line 80 says "outbound-webhooks subscriber forwards to integrators."
   - `apps/api/src/outbound-webhooks/outbound-webhooks.subscriber.ts:141`: literally has `if (event.silent) return;` — short-circuits ALL silent events including these three.

2. **Failure mode is reachable:** Confirmed via `packages/shared/src/outbound-webhooks/public-events.ts` that all three event types ARE first-class public webhook envelopes (`toPublicEnvelopes` cases at lines 735, 751, 778). They are listed in `KNOWN_PUBLIC_EVENT_TYPES` at lines 845-848 as partner-subscribable. So a partner CAN wire `contact.tag_changed` into n8n/CRM, and workflow-step changes WILL silently never deliver.

3. **Canonical types.ts (lines 172-186) explicitly documents:** "outbound-webhooks: skips delivery, so an API/workflow-driven change doesn't echo a webhook back to the very system that caused it (echo-loop avoidance)." So per the locked contract, silent IS supposed to skip outbound. But this contract is at odds with the three step files' author-intent comments.

4. **Not in CLAUDE.md/memory as intentional/locked.** `docs/architecture-review-2026-05-25-pass3.md:121-125` mentions `silent: true` is for workflow-dispatch self-trigger prevention; nothing addresses the outbound-webhooks side for workflow steps specifically. The "/v1 echo loop" resolution (architecture-review-2026-05-25.md:42) is about partner-originated API calls, which is a different case from workflow-driven changes that the partner didn't cause.

5. **Severity check:** Medium is right. Not Critical (no data loss/security). Not Low (it bites the integrations workstream — listed as actively paused but unblocking — the moment a partner wires `contact.tag_changed` for CRM sync of workflow-managed segmentation). Partners can't workaround by subscribing to `contact.updated` either (also published with `silent: true` from the same steps). The fix proposal is sound: either drop `silent` on the narrow events (preferred per step-file author intent) or remove the dead narrow publishes and update CLAUDE.md to record the decision. Both are minimal, isolated changes.

The internal contradiction within tag.ts is real and notable: lines 145-148 say "outbound-webhook subscriber doesn't [read silent]" but lines 158-162 say "they MUST honor `silent` or this step infinite-loops" — same file, same publish, opposite directions. That alone confirms author confusion that's worth resolving before pilot.


## M21. jump_to_step.maxJumps is parsed but never enforced
_Workflows / automations / triggers_ · `apps/api/src/lib/workflows/steps/control-flow.ts:171-189`

**Problem.** `jumpToStepHandler.parseConfig` accepts `maxJumps?: number` and stores it on the config (control-flow.ts:163-166), but `jumpToStepHandler.run` doesn't read it and the runner's jump branch (runner.ts:521-535) only checks the global `MAX_STEPS_PER_RUN`. The per-step cap is invisible at runtime — an author setting `maxJumps: 5` on a tight loop will see it iterate 100 times.

**Why dangerous.** Authors who put a `maxJumps: 3` on a retry-bound jump as a defensive measure get false confidence — the cap is silently ignored. Worse, the runner-global cap counts DISTINCT step ids via `progressCount = new Set(stepLog.map(stepId)).size`, so a tight 2-step jump cycle never reaches the global ceiling on cumulative jumps — only the `executedThisPickup` cap rescues it. A `wait → jump_to_step` loop with a 10-minute wait gets ONE iteration per pickup; after 100 wait+jump pickups (16 hours of wall-clock) it finally hits MAX_STEPS_PER_RUN. The local maxJumps would have caught it in 5 minutes if it actually worked.

**Impact.** Authoring footgun for any workflow using jump_to_step as a retry primitive. Most teams will never notice (the configurable cap is rare); the few who DO set it will silently get the wrong behavior. Will be invisible in the run log because nothing fails.

**Fix.** Either (a) enforce `maxJumps` in `jumpToStepHandler.run` by counting prior `jump_to_step` log entries for THIS node's id and returning `advanceWithError(409, 'jump_max_exceeded')` once the count crosses the cap — needs access to stepLog via ctx; or (b) drop the field from the config schema entirely and update describeConfig to remove any UI surface for it. Pick (a) — the comment at control-flow.ts:148-151 documents real intent.

**Verifier note.** Verified at the cited location. `jumpToStepHandler.parseConfig` (control-flow.ts:164-166) parses and stores `maxJumps`, but `jumpToStepHandler.run` (171-189) never references it — the only checks are target-existence and emitting the jump result. The runner (runner.ts:520-535) only enforces the global `MAX_STEPS_PER_RUN=100` on `jumpsUsed`, never per-step caps. The UI actively surfaces `maxJumps` as a labeled "Max jumps (optional)" Input with hint "Per-run cap" in step-editors.tsx:1075-1089, so authors can set it and reasonably expect enforcement — that elevates this from a dead-config smell to a true authoring footgun, just as the finder framed it. The doc comment at control-flow.ts:146-150 confirms the intent ("lets authors set a tighter local cap on a specific loop"). The secondary claim about `progressCount` being a Set-of-distinct-step-ids is also verified at runner.ts:197 — a tight 2-step jump cycle keeps `progressCount` at 2 forever, so only the `jumpsUsed > 100` global cap and `executedThisPickup` per-pickup cap stop it. Not listed in CLAUDE.md/memory as intentional. Severity "Medium" is calibrated correctly — no data loss or user-visible breakage, but a real correctness gap that's worse because of the UI surface. Fix (a) is the right call: count prior `jump_to_step` log entries for this node's id in `ctx.stepLog` (assuming StepHandlerContext exposes it; if not, that's the small enabling change).</reasoning>
</invoke>



---

# Low (36)

## L1. WorkflowWorkerService is a kitchen-sink lifecycle owner for unrelated sweepers and workers
_Architecture_ · `apps/api/src/workflows/workflow-worker.service.ts:1-367`

**Problem.** WorkflowWorkerService in apps/api/src/workflows/workflow-worker.service.ts boots and tears down 15+ sweepers and 2 BullMQ workers that have nothing to do with workflows: contact-last-inbound-drift, conversation-analytics-drift, auth-table-cleanup, outbound-webhook-delivery-cleanup, api-idempotency-cleanup, blob-orphan, outbound-event-retention, outbound-send-attempt-retention, workflow-run-retention, conversation-event-retention, inbound-media, broadcast-schedule worker + queue, and more. The file is 367 lines with 14 boolean started flags. The class header still claims it is the 'workflow worker + inbound-media sweeper bootstrap.'

**Why dangerous.** Adding any new background reconciler in another domain forces an edit into the workflows module, so domain ownership is invisible from the module graph. The 13-step try/catch onModuleInit means a partial failure leaves shutdown state inconsistent (e.g. authCleanupSweeperStarted true but webhookDeliveryCleanupStarted unset). When the schedule worker eventually grows into broadcasts or media gets its own retention job, everyone keeps piling on here. The graceful-shutdown chain documented in CLAUDE.md ('SIGTERM -> stop sweepers -> stop workflow worker -> close queue') is implemented inside one OnModuleDestroy hook in this file, so anyone debugging shutdown order has to scroll past 14 unrelated stops to find the workflow piece.

**Impact.** Maintainability: any domain owner editing their reconciler has to touch this file, increasing merge-conflict surface; correctness: a thrown lifecycle hook in any sweeper here can mask a missing stop on another; observability: 'WorkflowWorker' in the log line for an auth-cleanup failure is misleading.

**Fix.** Split into one lifecycle service per ownership domain and register them in their own modules. WorkflowWorkerService keeps workflow worker + workflow-waiting + workflow-awaiting-reply + workflow-run-retention. New SweepersModule (or per-domain services) takes the rest: auth-table-cleanup -> AuthModule, contact-drift -> ContactsModule, blob-orphan + outbound-send-attempt-retention + outbound-event-retention + conversation-event-retention + conversation-analytics-drift + api-idempotency-cleanup -> a small InfraSweepersModule. Each sweeper already exports start/stop fns from lib/sweepers/, so this is purely a wiring move. The broadcast-schedule worker + queue belong on BroadcastsModule.

**Verifier note.** Code matches the description, but the failure mode is overstated. Each try/catch block sets its `started` flag INSIDE the try, immediately after the matching `start*()` call (e.g. lines 172-174: `startAuthTableCleanupSweeper(); this.authCleanupSweeperStarted = true;`). So a thrown start NEVER flips that domain's flag, and shutdown only calls `stopX` when `xStarted === true`. The finder's example ("authCleanupSweeperStarted true but webhookDeliveryCleanupStarted unset") is actually the CORRECT outcome — webhookDelivery never started so it shouldn't be stopped. There is no cross-domain inconsistency.

Beyond the mechanical correctness point: (1) CLAUDE.md explicitly documents this file as the canonical home for the shutdown drain chain — the explicit ordering ("stop sweepers → stop workflow worker → close queue") is auditable precisely because it lives in one file; splitting it across modules makes ordering depend on Nest's reverse-init order, which is implicit and harder to audit when the drain budget (compose `stop_grace_period: 100s`) is load-bearing for not double-firing irreversible Meta sends. (2) The class is gated by `RUN_WORKER_INLINE` (lines 108-112); splitting forces every new lifecycle module to replicate or share this gate, increasing surface for the gate to drift. (3) Memory has multiple "production-grade, NOT overengineered" verdicts and the user's standing feedback warns "over-tinkering is the real risk."

The file IS misnamed and the doc-comment IS stale ("workflow worker + inbound-media sweeper bootstrap" understates 13 other domains). Renaming the class to something like `BackgroundJobsService` and updating the doc-comment would address the real (cosmetic) issue without the wiring churn. Medium is overstated for a pilot-stage, single-VPS service with no correctness bug — Low at most.


## L2. RealtimeFanoutService does not own its own subscriber lifecycle; WorkflowSubscribersService does
_Architecture_ · `apps/api/src/realtime/realtime-fanout.service.ts:32-54 and apps/api/src/workflows/workflow-subscribers.service.ts:42-66`

**Problem.** RealtimeFanoutService in apps/api/src/realtime/realtime-fanout.service.ts exposes registerSubscribers() but implements no OnModuleInit. The only call to that method lives in WorkflowSubscribersService.onModuleInit at apps/api/src/workflows/workflow-subscribers.service.ts:46, alongside register{Audit,Analytics,WorkflowDispatch}Subscribers(). So the workflows module is the de facto lifecycle owner of the realtime fanout subscribers even though realtime/ has its own module and its own service for exactly this concern.

**Why dangerous.** If WorkflowsModule is ever removed, restructured, or import-gated (e.g. the same env-flag treatment as DevModule), realtime fanout silently stops getting wired up but the API still serves traffic — every inbox client goes dark with no log line pointing to the cause. The 'rule of thumb' comment in realtime.module.ts explicitly says 'cross-cutting events->sockets translation in one place,' but the wiring contradicts that. Also impacts code review: a realtime subscriber rule change in fanout-rules.ts looks self-contained yet depends on a hook three modules away firing on init.

**Impact.** Operational risk if WorkflowsModule is touched; conceptual coupling between two modules with no Nest-DI signal of the dependency; one more reason new contributors can't tell who owns what.

**Fix.** Make RealtimeFanoutService implement OnModuleInit/OnModuleDestroy and register/teardown its own subscribers there. Move the audit + analytics + workflow-dispatch register calls into their own owner modules (AuditModule, AnalyticsModule, or fold them into the modules whose domain they observe) so each subscriber tier is owned by the module whose code generates the side effect. WorkflowSubscribersService can then own just registerWorkflowDispatchSubscribers — which is what its name implies.

**Verifier note.** The code claim is factually accurate: RealtimeFanoutService at apps/api/src/realtime/realtime-fanout.service.ts has no OnModuleInit and exposes registerSubscribers() that is only called from WorkflowSubscribersService.onModuleInit (line 46). However, the severity is overstated and the framing as a latent risk is weak.

Why it's overstated:
1. The centralization is INTENTIONAL and documented. WorkflowSubscribersService's class-level doc-comment explicitly says: "Single registration site for the bus subscribers that own audit / analytics / dispatch / cache-revalidate / realtime-fanout side effects." It also flags ordering concerns ("DO NOT re-parallelize the bus") that justify keeping subscribers visibly co-located. This is an architectural decision, not an oversight.
2. The failure mode ("WorkflowsModule is ever removed/restructured/env-gated") is purely hypothetical. WorkflowsModule is unconditionally registered in app.module.ts and there is no flag-gating in flight. The auto-memory's "smoke-boot before claiming green" rule would catch a missed init at the next dev boot — the failure isn't silent in practice.
3. No user-visible impact exists today. Realtime fanout is wired and firing. This is purely a where-does-the-init-live preference.
4. The proposed fix (move each tier's registration into its own module's OnModuleInit) is a lateral refactor, not a safety improvement. It would actually scatter the priority-ordering hint that the current single site preserves. The current owner is mis-named (WorkflowSubscribersService doesn't suggest it owns realtime-fanout wiring) but its doc-comment unambiguously declares that scope.
5. There IS a real but small smell: the realtime.module.ts comment says fanout is the ONLY event→socket translator, but the module doesn't own its own init lifecycle. The asymmetry is worth a rename (e.g. BusSubscribersService at app level, or make the four register*() owners explicit OnModuleInit each) — but at Low severity, defer-friendly, not Medium.

Revised severity: Low. It's a naming/co-location smell with no current runtime risk and a documented design rationale. The finder correctly identified the asymmetry; they overstate the operational risk because they discount the load-bearing doc-comment and the smoke-boot habit.


## L3. apps/api/src/lib/README.md and bus.ts reference subscribers/files that do not exist
_Architecture_ · `apps/api/src/lib/README.md:58 and apps/api/src/lib/events/bus.ts:28-31`

**Problem.** apps/api/src/lib/README.md line 58 documents a 'rate-limit.ts' file in lib/, but the actual rate limiter lives at apps/api/src/common/rate-limit.guard.ts + common/token-bucket.ts. lib/events/bus.ts:30 lists 'web-cache-revalidate' in the subscriber registration order, but no register*WebCacheRevalidate function exists — the api-client.ts comment confirms the cross-process bridge was removed 2026-05-29 and lib/events/subscribers/ only contains analytics.ts, audit.ts, workflow-dispatch.ts.

**Why dangerous.** Architecture documentation is one of the load-bearing artefacts CLAUDE.md tells contributors to read first. Stale 'this subscriber runs here' claims send debuggers down the wrong path when chasing a missed side effect. The README claim makes a contributor look for a file that does not exist and may re-introduce it as a copy of the real one.

**Impact.** Wasted time during incidents and onboarding; minor risk that the next contributor 'restores' the missing subscriber based on the doc-comment.

**Fix.** Drop the rate-limit.ts row from the README table (or repoint it to apps/api/src/common/rate-limit.guard.ts). In bus.ts, delete 'web-cache-revalidate ->' from the subscriber-order chain in the file header comment so the documented order matches reality (realtime-fanout -> audit -> analytics -> workflow-dispatch -> outbound-webhooks).

**Verifier note.** Both claims independently verified against current code:

1. apps/api/src/lib/README.md:58 lists `rate-limit.ts` as living in apps/api/src/lib/. Directory listing of apps/api/src/lib/ shows no such file. `find apps/api/src -name 'rate-limit*'` returns only `apps/api/src/common/rate-limit.guard.ts`, which is the NestJS guard (with companion `common/token-bucket.ts`) — exactly as CLAUDE.md "Per-user rate limiting" describes. The README row is doc drift.

2. apps/api/src/lib/events/bus.ts:30 documents the subscriber order as `realtime-fanout → audit → analytics → workflow-dispatch → web-cache-revalidate → outbound-webhooks`, and line 36 even claims `web-cache-revalidate is now fire-and-forget inside its own subscriber`. Listing apps/api/src/lib/events/subscribers/ shows only analytics.ts, audit.ts, workflow-dispatch.ts. The grep for `web-cache-revalidate` / `webCacheRevalidate` returns only the two stale references inside bus.ts itself — no register function, no subscriber class. apps/web/src/lib/api-client.ts:125 explicitly notes the `/api/internal/revalidate` bridge was removed, corroborating the finder's account.

Neither CLAUDE.md nor MEMORY.md flags either reference as intentional. The proposed fix (delete the rate-limit.ts row from the README table and strip `web-cache-revalidate →` from the bus.ts comment chain) is purely textual, doesn't introduce a worse failure mode, and aligns the docs with shipped code.

Severity stays Low — the impact is doc-confusion during onboarding/incident-hunting, not a runtime bug. No reachable failure mode beyond contributor time-loss or the long-tail risk of someone "restoring" the missing subscriber based on the doc. Confidence: high.


## L4. Session/Verification expiry sweeper uses a full table scan — comment claims an index that doesn't exist
_Auth / session / permissions_ · `prisma/schema.prisma:416-429 (Session model) and lines 458-467 (Verification model); sweeper at apps/api/src/lib/sweepers/auth-table-cleanup.ts:69-74 with stale comment at lines 19-20`

**Problem.** auth-table-cleanup.ts:19 claims 'Both DELETEs hit the `@@index([expiresAt])` / `([identifier])` indexes — cheap even when the tables are large.' But the schema only declares `Session.@@index([userId])` (line 428) and `Verification.@@index([identifier])` (line 466). Neither table has an index on `expiresAt`. The sweeper's `deleteMany({ where: { expiresAt: { lt: now } } })` therefore runs a sequential scan on Session and Verification every 24h.

**Why dangerous.** Today's Session table only has a few hundred rows so the scan is invisible. At pilot scale (~50-200 active users × few sessions each + 90-day TTL + every reconnect/login churning a row) Session grows to ~10k-100k rows; Verification (if password-reset / email-verify flows are turned on later, see schema comment) grows similarly. A seq scan during the nightly sweep then locks rows in random page order and competes with the live login path's `Session.token` lookup. Worse: the sweeper runs inside the same NestJS process that serves auth, so a slow seq scan effectively becomes a self-DoS on logins for the duration of the sweep.

**Impact.** Latent until ~50 tenants or password-reset ships; then the nightly 3am sweep can starve login latency. Easy to miss because the typecheck and dev environment don't surface it.

**Fix.** Add `@@index([expiresAt])` to both Session and Verification in prisma/schema.prisma, generate a migration, and update the sweeper's comment block to reference the real indexes. While there: consider extending the sweeper to also vacuum LoginAttempt rows where `lastFailedAt < now() - 30 days AND (lockedUntil IS NULL OR lockedUntil < now())` — that table is also unbounded today and has `@@index([lockedUntil])` but no `lastFailedAt` index (the schema already has the maintenance gap; if the sweeper picks this up, give it a `@@index([lastFailedAt])` too).

**Verifier note.** Facts confirmed: The sweeper at /home/aliubuntu/projects/loadless_projects/customer-communication-platform/apps/api/src/lib/sweepers/auth-table-cleanup.ts:69-74 does run `deleteMany({ where: { expiresAt: { lt: now } } })` on Session and Verification, and the schema at prisma/schema.prisma:416-429 + 458-467 only declares `@@index([userId])` and `@@index([identifier])` — no `@@index([expiresAt])` on either. The migration 0_init/migration.sql confirms no raw SQL covers it either. So the comment at lines 19-20 is genuinely stale: it claims an index that does not exist.

However, severity is overstated as Medium. The "self-DoS on logins" failure mode is speculative:
1. Login path looks up Session by `token` (unique index) — that's an index seek, not a seq scan, and Postgres MVCC means the DELETE only takes row locks on the expired rows it deletes (never on the live session row a logging-in user is touching).
2. At 10k-100k rows a seq scan + filtered delete on Session is sub-second on any pilot-class VPS; not enough to "starve" login latency. The contention story conflates seq-scan CPU with lock contention, which isn't how MVCC works here.
3. Verification is essentially empty today — schema comment notes the invite flow uses the separate Invite model, so Verification only fills if password-reset/email-verify is enabled later. That hypothetical doesn't justify Medium today.
4. The original sweeper comment lying about an index is real, but it's documentation drift, not a correctness or latency bug under current conditions.

Right severity is Low: missing index + stale comment, easy clean-up. The proposed fix (`@@index([expiresAt])` on both + correcting the comment) is safe and trivially correct; no risk of a worse failure mode. The LoginAttempt extension is a reasonable adjacent cleanup but unrelated to the headline claim. Not in CLAUDE.md / memory as intentional or deferred. Recommend downgrading to Low and adopting the fix.


## L5. Internal-bus safeEqual can throw on non-ASCII probes (length vs UTF-8 byte mismatch)
_Auth / session / permissions_ · `apps/api/src/auth/internal-session.controller.ts:35-38`

**Problem.** `safeEqual(a, b)` guards length equality with `a.length !== b.length` (JS string length = UTF-16 code units), then runs `timingSafeEqual(Buffer.from(a), Buffer.from(b))` (UTF-8 byte length). A unicode string can match the expected secret's `.length` while having a different UTF-8 byte length. crypto.timingSafeEqual throws RangeError when buffer byte lengths differ.

**Why dangerous.** An attacker sending `X-Internal-Secret: <unicode-string-with-matching-codepoint-length>` triggers an uncaught throw inside the controller. NestJS's exception filter converts it to a 500. Doesn't grant access — but the 500-vs-401 oracle is detectable and the uncaught throw burns CPU on bcrypt-cost paths nowhere, so impact is informational only. Could also confuse alerting (500 spam in /api/internal/session-invalidated logs).

**Impact.** No auth bypass. Cosmetic: 500 instead of 401, a small noise signal in logs, and a theoretical detection vector. Path is reachable from any caller that can hit the docker-internal port; since /api/internal is only allowlisted in the proxy and not exposed publicly via Caddy, blast radius is small.

**Fix.** Compare byte lengths instead of code-unit lengths: `const aBuf = Buffer.from(a); const bBuf = Buffer.from(b); if (aBuf.length !== bBuf.length) return false; return timingSafeEqual(aBuf, bBuf);` — or restrict the header to ASCII before comparing.

**Verifier note.** Verified the code at apps/api/src/auth/internal-session.controller.ts:35-38 exactly matches the finding. Confirmed the failure mode is reproducible: 'aé' and 'ab' both have JS `.length === 2` but UTF-8 byte lengths 3 vs 2, causing crypto.timingSafeEqual to throw `RangeError: Input buffers must have the same byte length`. Caddy (deploy/Caddyfile.template:144) blocks /api/internal/* at the edge with 404, so the route is reachable only from loopback / docker-internal — this correctly limits blast radius and the finder already acknowledged it. The 500-vs-401 oracle is real but informationally weak (attacker still doesn't learn the secret, just that the comparator throws on certain byte/codepoint mismatches). Not listed as intentional/locked/deferred. The proposed fix (compare Buffer byte lengths instead of string `.length`) is the canonical idiom and introduces no new failure mode. Severity "Low" is appropriate — cosmetic robustness issue, no auth bypass.


## L6. /api/register surfaces `email_taken` discriminator — account-enumeration via API
_Auth / session / permissions_ · `apps/api/src/registration/register.controller.ts:126-131`

**Problem.** RegisterController catches Prisma P2002 (unique constraint) and rethrows `ConflictException({ error: 'email_taken', detail: 'An account with this email already exists.' })`. The web form already surfaces this same message, so the leak isn't created here — but the API endpoint is reachable by anyone hitting POST /api/register directly (it's behind the public-page allowlist), so an attacker can enumerate accounts cheaply: 5 register attempts/min/IP per the bucket, but distributed botnets defeat that.

**Why dangerous.** Combined with the lockout path that returns 'Invalid email or password' for both wrong-password and deactivated-user, registration becomes the cheaper enumeration oracle: 'email_taken' is a binary signal per try with no lockout. Doesn't enable account takeover, but builds the targeting list for credential-stuffing.

**Impact.** Affects spam/spear-phishing risk for pilot customer users — knowable accounts get the first credential-stuffing waves. Low because the same surface exists on the web form (it's the user-friendly behavior the product wants), and 5/min/IP is reasonable. Worth flagging because the API endpoint has fewer compensating controls than the form.

**Fix.** Two options. (a) Keep current behavior — UX matches the form, ship as-is. (b) Convert to a generic success that also kicks a 'reset your password' email when the email is taken (Auth0's posture). For pilot scope (a) is fine; document the tradeoff in the controller doc-comment so a future review doesn't re-litigate. Separately worth tightening the per-IP bucket: today /api/register's `registerBucket` is 5/min/IP which lets a single IP probe 7,200 emails/day; tighter would be 5/hour/IP with a fail-closed posture on `req.ip === 'unknown'` similar to the proxy's /login handling.

**Verifier note.** Code at apps/api/src/registration/register.controller.ts:126-131 matches the finding verbatim: P2002 → ConflictException with `{ error: 'email_taken', detail: 'An account with this email already exists.' }`. RegisterController has no SessionGuard (correct — visitors have no session pre-registration), so POST /api/register is publicly reachable. The 5/min/IP `registerBucket` at line 27 is exactly as described, and the math (5 × 60 × 24 = 7,200 probes/day per IP) is correct.

The finder honestly caveats this: the web form already leaks the same signal (intentional UX), there's no account-takeover path, and option (a) of the fix is literally "ship as-is, document the tradeoff." That's the right call for a Low-severity information-leak smell — it's a known design tension between UX (helpful "this email is taken") and security (account enumeration), and the finder names it correctly. CLAUDE.md / memory don't list this as locked or deferred, so it's not a re-litigation.

Severity is right: Low is appropriate. Critical/High would require an actual auth bypass or data-loss; this is just enumeration. The tighter-bucket suggestion (5/hour/IP) is a real lever but at pilot scale even the current 5/min/IP is reasonable, so leaving it is fine.

Finding stands as written.


## L7. MessageThread re-renders the whole 500-message timeline every 60 seconds
_Chat (highest priority)_ · `apps/web/src/features/inbox/components/message-thread.tsx:813`

**Problem.** `MessageThreadImpl` calls `useTzNow()` which subscribes to BOTH the stable tz context AND the 60s-ticking NowContext (line 813). Every minute tick → MessageThreadImpl re-renders → the `timeline.map((entry, idx) => ...)` walk runs through every loaded message bubble. `dayLabels` is memoized on `[timeline, tz, todayKey]` so it bails, but `messagesById = useMemo([data.messages])` and the JSX walk still run, plus every child reconciler pass.

**Why dangerous.** On a busy thread with the slice cap near 500 messages, the entire bubble walk + memo checks + reconciler pass fire every 60s on an active tab even when nothing else changed. Per the inline comment on tz-provider.tsx (line 22-29), `useTzNow()` should be used ONLY where live relative time is needed; absolute-timestamp consumers should use `useTimezone()`. The thread only needs `tz` directly — `now` is read via `nowRef` and never consumed in render.

**Impact.** Steady CPU heartbeat in every open inbox tab. Multiplies with multi-tab agents and during long shifts — exactly the 60s heartbeat the split-context architecture in tz-provider exists to prevent. Memory `project_no_split_paint_time_rule` warns about exactly this anti-pattern. The dayLabels memo bails on `todayKey` identity but the surrounding render does not bail.

**Fix.** Replace `const { tz, now } = useTzNow();` with `const tz = useTimezone();` and read `now` only inside the `dayLabels` `useMemo` callback through a fresh helper that reads `useTzNow()` in a tiny child component, OR push the `dayLabels` computation into a small inner component that consumes `useTzNow()` so the bulk MessageThreadImpl doesn't subscribe. Simplest: since `nowRef` is the only consumer, read it inline via `Date.now()` (the day labels only flip at local midnight, so a once-per-day re-compute via a daily timer in a tiny effect is more than enough and removes the 60s churn).

**Verifier note.** Verified the code at message-thread.tsx:813 — `useTzNow()` is indeed called there and the function body of `MessageThreadImpl` does subscribe to `NowContext`, so the entire impl re-renders on the 60s tick. That part of the claim is factually correct.

However, the impact framing ("steady CPU heartbeat", "reconciler pass for ~500 entries", High severity) is overstated for these reasons:

1. `MessageBubble` IS memoized (`memo(MessageBubbleImpl)` at message-bubble.tsx:323). All its props are stable across a non-changing tick:
   - `message={entry.data}` from `timeline` (useMemo on stable deps)
   - `senderName/senderAvatarUrl` from `memberById` (useMemo'd) → primitive equal
   - `contactName/contactSeed` from props (stable)
   - All callbacks (`beginReply`, `jumpToOriginal`, `forwardOne`, `startSelect`, `dismissFailed`, `retryFailed`) are useCallback'd
   - `selection.selecting`, `selection.isSelected(...)` — selection state is stable per tick
   - `searchQuery` / `isActiveSearchMatch` — derived from stable state
   So React.memo bails on every bubble. Actual reconciler work per tick = one MessageThreadImpl function-body run + ~500 createElement calls + ~500 shallow-compares of primitives. That's microseconds to low-milliseconds of work, not a measurable CPU heartbeat.

2. `dayLabels = useMemo([timeline, tz, todayKey])` BAILS when `todayKey` is unchanged (i.e. within the same calendar day), so the per-entry walk inside the memo does NOT re-run on every tick — only the outer JSX `timeline.map` runs.

3. The inline comment at lines 805-822 explicitly acknowledges this design: the author deliberately subscribed to `now` to drive `todayKey` (so "Today"/"Yesterday" labels flip at local midnight) and routed it through `nowRef` to keep the deeper memo's deps stable. This is documented intentional design, not an oversight.

4. The finder's proposed fix (read `Date.now()` inline + a daily timer in a tiny effect) loses the SSR-stable `serverNow` initialization (the `TimezoneProvider` initializes `now` to server-render time precisely so SSR and first client paint produce identical day-separator strings — see memory `project_no_split_paint_time_rule` which warns against introducing `Date.now()` reads in render). That fix would re-introduce the exact split-paint bug class the user's auto-memory explicitly warns about.

5. A reasonable lightweight refactor exists (push `useTzNow` consumption into a tiny inner component that produces `dayLabels` via a memo) but the win is small enough that the existing design is defensible. It's a Low-severity cleanup, not a High-severity perf cliff.

Severity should be Low (cleanup / smell), not High.


## L8. lastStageRef Map in useConversationCounts grows unbounded for the session
_Chat (highest priority)_ · `apps/web/src/features/inbox/hooks/use-conversation-counts.ts:78`

**Problem.** `use-conversation-counts.ts` keeps `lastStageRef = useRef<Map<contactId, stageId|null>>(new Map())` and writes to it on every `contact:updated` frame the tab receives. It is never trimmed.

**Why dangerous.** Over a long shift with high contact churn (bulk imports, broadcasts, n8n flows updating contacts) the map accumulates one entry per unique contact the tab has ever seen. On a team handling thousands of distinct contacts per day, the map grows monotonically across reconnects. Entries are small (string keys + nullable string values) so the memory cost is modest, but it's a textbook grow-only leak the rest of the codebase explicitly bounds (cf. revokedBlobs, handshakeBuckets, latestContactRef is at least scoped per-team rendering).

**Impact.** Slow memory growth on long-lived tabs. Tightening this matches the LRU/cap discipline applied elsewhere in the codebase.

**Fix.** Cap with an LRU policy (oldest-first eviction at ~5k entries) the same way `revokedBlobs` in use-conversation-events.ts does it, or simply drop entries older than N events by tracking insertion order with a small counter.

**Verifier note.** The code does match the claim — `lastStageRef` is a `useRef<Map>` at apps/web/src/features/inbox/hooks/use-conversation-counts.ts:78, written on every `contact:updated` frame at line 129, never trimmed. The failure mode (monotonic growth across the tab's lifetime) is real.

However, Medium is overstated for three reasons:

1. **Scale math doesn't support Medium.** Each entry is `contactId (UUID string) → stageId (UUID string | null)` — roughly 80 bytes including Map overhead. At 100k unique contacts seen in one tab lifetime, the map is ~8 MB. At realistic pilot scale (CLAUDE.md says "one pilot customer", "single VPS pilot"), a single team is unlikely to see more than a few thousand unique contacts per session. That's KB, not MB.

2. **CLAUDE.md explicitly sanctions grow-only Maps at this scale.** Under "Skip until forced to revisit": `Cache eviction on lib/providers/config.ts — only past ~5 tenants (current Map is grow-only by design)`. And under "Scaling cliffs to anticipate (don't pre-build)": `50-200 tenants: in-process credential cache + grow-only Maps start to leak. Fix when seen.` The codebase's stated discipline is to NOT pre-build LRU caps on grow-only Maps before they bite. The `feedback_simple_clean_solid_fast` memory entry reinforces this.

3. **The revokedBlobs comparison is weaker than the finder claims.** Its own comment says "a few hundred sends per agent per shift × 30 chars per blob URL = trivial — but capped for hygiene." That's an explicitly admitted unnecessary cap. It's not evidence that grow-only Maps are a coding standard violation; it's evidence that one engineer added one for hygiene in one place.

The fix itself is also non-trivial: evicting an entry causes the next `contact:updated` for that contact to hit the `known=false` branch and fire a defensive refresh (line 127-131). At a low cap (say 1k), a tab triaging across the customer base could lose the dedup property the file explicitly preserves ("A bulk field edit on 500 contacts now fires zero GETs instead of 500"). The fix needs a generous cap (5k+) to avoid regressing the no-op dedup.

Verdict: real but Low — a defer-friendly hygiene smell, not a Medium that warrants action this session.


## L9. ~70 bare client fetches bypass apiFetch/session-expiry handling
_Code quality / dead code / duplication_ · `Sample sites: apps/web/src/features/contacts/components/contact-browser.tsx:88, apps/web/src/features/settings/components/outbound-webhooks-manager.tsx:247,278,291,389,403, apps/web/src/features/inbox/components/inbox-shell.tsx:491, apps/web/src/features/inbox/components/reply-box.tsx:403,431,479,746, apps/web/src/features/workflows/components/builder/workflow-builder.tsx:205,227,250 — full set is the ~70 `fetch("/api…")` / `fetch(\`/api…\`)` calls in apps/web/src.`

**Problem.** `apps/web/src/lib/api/client-fetch.ts` exports `apiFetch` that routes through `fetchWithSessionGuard` (auto-redirect on 401 → /logout → /login). About 70 client-side mutations across apps/web still call bare `fetch("/api/…", …)` directly and skip that guard. The migration is described in the file's JSDoc as "opportunistic" but has stalled.

**Why dangerous.** When a session expires (e.g. an open tab left overnight, an admin remote-revokes the session, a deploy invalidates cookies), the user does NOT bounce to /login — instead the 401 body gets treated as a domain error and surfaces as a generic toast ("Server returned HTTP 401") with the UI stuck in a broken state. The user has to manually refresh to recover. In team-chat hooks and contact-browser this also means subsequent mutations keep firing and failing.

**Impact.** User-visible: silent breakage on every long-lived tab past session expiry. Bites at pilot scale already (one tenant, but power-users will absolutely keep tabs open for days). Class-level fix, not per-site.

**Fix.** Either (a) finish the migration with a codemod that rewrites the bare calls to `apiFetch(...)` (one-shot, no behavior change since same-origin + credentials already match) and add an ESLint rule (e.g. `no-restricted-syntax` on bare `fetch("/api…")`) to prevent regression, or (b) drop `apiFetch` and inline 401 handling into a global `<SessionExpiryWatcher>` that listens for 401 responses via a Response interceptor — pick one source of truth instead of leaving a half-migrated wrapper.

**Verifier note.** The factual claims are correct: `apiFetch` (apps/web/src/lib/api/client-fetch.ts) routes through `fetchWithSessionGuard` (apps/web/src/lib/auth/client-session-guard.ts), grep confirms ~70 bare `fetch("/api/…")` callsites in apps/web/src vs ~32 `apiFetch` callsites, and all spot-checked cited lines match exactly (contact-browser:88, outbound-webhooks-manager:247/278/291, inbox-shell:491, reply-box:403/431/479). However, the framing is overstated on two fronts:

1. INTENTIONAL, NOT STALLED. The JSDoc at client-fetch.ts:23–27 explicitly says: "Use for NEW client mutations and for any absolute-URL call. Existing relative-URL fetches still work as-is (same-origin → cookies travel); migrate them opportunistically, not in a big bang." And the session-guard's own JSDoc (client-session-guard.ts:11–15) explicitly says: "Use sparingly — only on inbox-critical reads. We don't want a transient 401 from a misbehaving endpoint to nuke a half-typed draft. The user-action paths (send, mark-read) keep their existing error handling so a truly transient 401 surfaces as 'couldn't send, retry' instead of a forced logout." Both files document this as a deliberate design call, not technical debt. The finder's "migration has stalled" is a misreading.

2. INBOX-CRITICAL PATHS ARE ACTUALLY GUARDED. The high-value session-expiry case (agent leaves inbox open overnight, then tries to send) is already covered: `use-conversation-counts.ts:82`, `use-conversation-events.ts:374/553/664`, `use-conversation-attachments.ts:73`, and `inbox-shell.tsx:344` all route through `fetchWithSessionGuard`. These poll/refetch on every socket event, so an inbox tab will already be bounced to /logout before the user clicks any bare-fetch action like send/reply/template. The actual reachable failure mode is narrower than claimed: an idle settings/contacts/workflows tab (no polling) where a user comes back after session expiry, clicks a mutate button, gets a toast HTTP 401, and recovers with a page refresh that bounces to /login normally. Not silent breakage; not data-loss; not a security hole.

3. PROPOSED FIX TRADEOFF. The finder's alternative (b) — global Response interceptor / SessionExpiryWatcher — would re-introduce exactly the problem the current author called out: a transient 401 from any endpoint nukes half-typed drafts and unrelated state. The codemod alternative (a) is fine but is mechanical cleanup, not a bug fix.

Severity should be Low: real consistency issue, narrow blast radius (idle non-inbox tabs only), explicitly documented as intentional opportunistic migration by the author. Not Medium because no inbox-critical user flow is reachable in the failure mode — those paths are already on the guard. The finding deserves a backlog item, not a "will bite at pilot scale" framing.


## L10. Stale doc references to deleted server.ts / lib/env.ts in auth files
_Code quality / dead code / duplication_ · `apps/web/src/lib/auth/better-auth.ts:45,55 and apps/web/src/proxy.ts:326`

**Problem.** After the Phase-5 cleanup, Next.js no longer has a custom `server.ts` (replaced by `next start` + `apps/web/instrumentation.ts`), and `lib/env.ts` was replaced by `@ccp/config`'s `validateEnv()`. Two doc comments still reference the deleted files.

**Why dangerous.** Misleads anyone tracing auth wiring — the comments tell you to look at `server.ts` / `lib/env.ts` to find the env-validation gate, but those files don't exist. Cost is wasted grep time, not a bug. Bug class: documentation that survives a refactor without being updated, identical to the conversations-service drift above (same root cause: wide-blast-radius rewrite without doc sweep).

**Impact.** Maintenance only; readers will hit a dead reference and have to track down the real boot path themselves.

**Fix.** Replace the `lib/env.ts` / `server.ts` references with `@ccp/config` (the package that owns `validateEnv`) and `instrumentation.ts` (the Next.js boot hook that calls it). One-line edit each.

**Verifier note.** Verified the finding by reading the actual lines and checking file existence.

1. `apps/web/src/lib/auth/better-auth.ts:45` says "runtime validation in lib/env.ts (called from server.ts) is the real gate." — but `apps/web/src/lib/env.ts` does not exist and `server.ts` does not exist anywhere in the repo. The real boot path is `apps/web/instrumentation.ts` (which `await import("@ccp/config")` and calls `validateEnv("web")`).

2. `apps/web/src/lib/auth/better-auth.ts:55` says "server.ts validates env on boot and exits if the real secret is missing" — `server.ts` doesn't exist; `instrumentation.ts` does the boot validation now.

3. `apps/web/src/proxy.ts:326` says "BETTER_AUTH_URL is `prodRequired` (lib/env.ts)" — `lib/env.ts` doesn't exist; the `prodRequired` array now lives in `packages/config/src/index.ts:63`.

All three references are stale doc strings left over from the Phase-5 cleanup that removed `server.ts` and `lib/env.ts`. CLAUDE.md confirms the runtime gate is now `instrumentation.ts` calling `validateEnv()` from `@ccp/config`. No runtime impact, but the comments mislead a reader tracing auth wiring. Severity Low is correct — strictly a documentation drift smell, identical pattern to other doc-staleness findings.

Fix is a 3-line comment edit, no behavioral risk. Finding stands as written.


## L11. Dead re-exports in broadcasts-browser.tsx
_Code quality / dead code / duplication_ · `apps/web/src/app/(app)/broadcasts/broadcasts-browser.tsx:33-44 (the `export { … } from "./broadcasts-cookies"` block plus the comment above it)`

**Problem.** `apps/web/src/app/(app)/broadcasts/broadcasts-browser.tsx:33-44` re-exports `BROADCASTS_SEARCH_COOKIE`, `BROADCASTS_STATUS_COOKIE`, `BROADCASTS_VIEW_COOKIE`, `parseBroadcastStatus`, `parseBroadcastView`, `BroadcastStatusFilter`, `BroadcastView` with the comment "Re-export the pure primitives so legacy client-side imports keep working through this file." No external file imports any of these names through `broadcasts-browser.tsx` — the only inbound import is `{ BroadcastsBrowser }` from `apps/web/src/app/(app)/broadcasts/page.tsx:9`. All other consumers already import directly from `./broadcasts-cookies`.

**Why dangerous.** Dead exports add maintenance noise (any change to the cookie module triggers an unused re-export refactor) and the comment claiming "legacy client-side imports keep working" is false today, so it actively misleads.

**Impact.** None at runtime. Code-hygiene only.

**Fix.** Delete the `export { … }` block and its comment; keep the immediately-following `import { … } from "./broadcasts-cookies"` which is the only consumer.

**Verifier note.** Verified independently. broadcasts-browser.tsx:32-44 contains exactly the comment + `export { ... } from "./broadcasts-cookies"` block claimed. A repo-wide grep for inbound imports finds only `import { BroadcastsBrowser } from "./broadcasts-browser"` in page.tsx (the other two hits are textual mentions in comments inside broadcasts-cookies.ts and broadcasts.service.ts). page.tsx itself imports the cookie primitives directly from `./broadcasts-cookies` on lines 14-20, never via the re-export. The block is dead, and its comment ("legacy client-side imports keep working through this file") is factually wrong today. Severity Low is right — pure code hygiene, no runtime effect. Proposed fix is safe: the immediately-following local `import { ... } from "./broadcasts-cookies"` on lines 46-52 is the actual in-file consumer and is preserved. No CLAUDE.md / memory rule protects this re-export (the "use client" boundary split memory talks about putting parsers in a non-client sibling, which is already done — the re-export adds nothing).


## L12. Duplicated window-state logic in workflows/events.ts despite shared util existing
_Code quality / dead code / duplication_ · `apps/api/src/lib/workflows/events.ts:284-329`

**Problem.** `apps/api/src/lib/workflows/events.ts:316-329` reimplements `computeWindowStateFromIso` plus the constants `WINDOW_MS` and `WINDOW_CLOSING_SOON_MS`. The same logic lives in `packages/shared/src/utils/window.ts::computeWindowStatus` as `WINDOW_DURATION_MS`/`WINDOW_CLOSING_SOON_MS`, already used by `apps/api/src/messages/messages.service.ts`, `external-v1-messaging.service.ts`, `lib/messaging/send-interactive-internal.ts`, and `lib/workflows/branch-presets.ts`. The comment at line 284-287 claims the duplicate exists "to avoid pulling the whole shared helper into the events module" and that "drift is a non-issue because both anchor on a hardcoded 24h / 4h pair."

**Why dangerous.** The claim is wrong on two fronts: (1) `computeWindowStatus` is already imported from the same `@ccp/shared/utils/window` subpath by several other api files, so the import cost is zero — the helper is in the bundle either way; (2) when the WhatsApp window changes to a per-channel `capabilities.freeFormWindowMs` (the shared util already takes `windowMs` as a parameter for exactly this), workflow events will keep emitting the WhatsApp 24h state and silently lie. The constant name also differs (`WINDOW_MS` here vs `WINDOW_DURATION_MS` in shared) — a future global rename would miss this copy.

**Impact.** Latent. Doesn't bite today (single channel, hardcoded 24h). Bites the moment a second channel with a different window lands, or anyone updates the shared constants and forgets this private copy.

**Fix.** Replace `computeWindowStateFromIso(lastInboundAtIso)` with `computeWindowStatus(lastInboundAtIso).state`, drop the local `WINDOW_MS` / `WINDOW_CLOSING_SOON_MS` constants and the `computeWindowStateFromIso` function. Use the existing `@ccp/shared/utils/window` import that other files in the same module already use.

**Verifier note.** Independently verified the cited code. apps/api/src/lib/workflows/events.ts:284-329 does carry a local `WINDOW_MS` (24h), `WINDOW_CLOSING_SOON_MS` (4h), and a `computeWindowStateFromIso` that replicates the shared util's state-machine. The comment claims "avoid pulling the whole shared helper into the events module" — but a grep shows `@ccp/shared/utils/window`'s `computeWindowStatus` is already imported by apps/api/src/messages/messages.service.ts (line 52), external-v1-messaging.service.ts (line 42), lib/messaging/send-text-internal.ts (line 17), lib/messaging/send-interactive-internal.ts (line 18), and lib/workflows/branch-presets.ts (line 1). The bundle already carries it, so the stated rationale is false. The shared helper takes `windowMs` as a parameter (window.ts:39) and the production call sites pass per-channel `windowMs` from `capabilities.freeFormWindowMs` (e.g. messages.service.ts:524, 1030; external-v1-messaging.service.ts:426; send-text-internal.ts:132; send-interactive-internal.ts:104). The workflow events copy hardcodes 24h, so contact snapshots emitted to workflows / outbound webhooks will silently report the WhatsApp default state once a second channel with a different freeFormWindowMs lands — exactly aligning with the multi_channel_seam_prep memo's "channel is Conversation-owned" expansion plan. Constants are also named differently (`WINDOW_MS` vs `WINDOW_DURATION_MS`), so a future shared-constant rename would miss this copy. Severity stays Low: latent (single channel today), defer-friendly, but the fix is a few-line drop-in replacement (`computeWindowStatus(lastInboundAtIso).state`, delete the local constants + function) with no observable behavior change at single-channel scale. Not listed as intentional/locked/deferred anywhere in CLAUDE.md or memory. Finding stands as written.


## L13. P2002 detection duplicated as both local helper and ad-hoc instanceof checks
_Code quality / dead code / duplication_ · `Helper: apps/api/src/team-chat/channels.service.ts:1305-1312 and apps/api/src/lib/conversations/mutations.ts:47-51. Inline sites: see grep `err.code === "P2002"` / `err.code === "P2025"` across apps/api/src (~23 hits).`

**Problem.** Prisma's `P2002` (unique-violation) is checked in ~23 places across apps/api/src with two different idioms: `apps/api/src/team-chat/channels.service.ts:1305-1312` has a local `isP2002` helper that duck-types `err.code === "P2002"`, while most other sites (e.g. `conversations.service.ts:502`, `apps/api/src/team/audience-groups/audience-groups.service.ts:144`, `apps/api/src/external/v1/api-idempotency.service.ts:111`, `apps/api/src/lib/workflows/dispatcher.ts:158,161,399`, `apps/api/src/registration/register.controller.ts:126`, `apps/api/src/lib/workflows/steps/target.ts:187`) inline `err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"`. Similarly P2025 has a one-off `isP2025` helper in `lib/conversations/mutations.ts:47`.

**Why dangerous.** Two idioms behave subtly differently: the duck-typed `isP2002` matches any object with `code === "P2002"` (including a re-thrown wrapper or a custom error mimic), while the `instanceof` check requires the actual Prisma class. Mixing the two means a future re-thrower (e.g. a transaction wrapper that wraps the original in a generic Error with `cause`) will be caught by some sites and not others, producing inconsistent 409 vs 500 responses. Also pure duplication smell — the helper exists, it's just hidden inside one service.

**Impact.** Maintenance + consistency. Low blast radius today (no re-thrower in the codebase), but every new error-handling site has a 50/50 chance of picking the wrong idiom.

**Fix.** Hoist `isPrismaError(err, code)` (one function, parameterised on the code) into `apps/api/src/common/prisma-exception.filter.ts` or a sibling `prisma-errors.ts`, using `err instanceof Prisma.PrismaClientKnownRequestError && err.code === code` (the stricter idiom, matching the existing global filter at `apps/api/src/common/prisma-exception.filter.ts:78,81`). Replace both helpers and the inline checks. One PR, no behavior change.

**Verifier note.** Verified the cited locations match the claim exactly:

1. `apps/api/src/team-chat/channels.service.ts:1305-1312` — local `isP2002` helper that duck-types via `"code" in err && (err as { code?: string }).code === "P2002"`. CONFIRMED.

2. `apps/api/src/lib/conversations/mutations.ts:47-51` — local `isP2025` helper using stricter `instanceof Prisma.PrismaClientKnownRequestError` + code check. CONFIRMED.

3. Grep across apps/api/src shows the two idioms genuinely coexist: 13+ inline `instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"` sites (external-v1.service.ts:801, api-idempotency.service.ts:111, ingest-call.ts:365, register.controller.ts:126, contacts.service.ts:166/395/1146/1228, messages.service.ts:676/1632, target.ts:187, ingest.ts:758/1192, etc.), and at least 4 duck-typed `(err as { code?: string }).code === "P2002"` sites (external-v1.service.ts:413/1343/1388/1416, contacts.service.ts:166, stages.service.ts:278). Same split for P2025. CONFIRMED.

The failure mode described — duck-typed matcher catching a re-wrapped Prisma error that `instanceof` would miss — is correctly identified as hypothetical ("Low blast radius today (no re-thrower in the codebase)"). There is also a global `PrismaExceptionFilter` at apps/api/src/common/prisma-exception.filter.ts that uses the stricter idiom for uncaught errors, so the divergence only matters at handler sites that swallow the error and return a domain shape.

CLAUDE.md / memory don't lock this in either direction. The "Simple, clean, solid, fast" quality bar and "don't over-tinker" guidance balance out — this is a real but minor smell.

Severity self-assessed as Low is appropriate: it's a maintenance/consistency concern, not user-visible, no current bug. The proposed fix (hoist `isPrismaError(err, code)` into a shared module using the stricter `instanceof` idiom, matching the global filter) is concrete, no-behavior-change, and would slightly tighten error handling at the duck-typed sites.

Finding stands at Low.


## L14. Unused public exports in packages/shared/src/contacts/reserved-fields.ts
_Code quality / dead code / duplication_ · `packages/shared/src/contacts/reserved-fields.ts:11 (RESERVED_FIELD_KEYS), :60 (normalizeFieldKey)`

**Problem.** `RESERVED_FIELD_KEYS` and `normalizeFieldKey` are exported from `packages/shared/src/contacts/reserved-fields.ts` but consumed only inside the same file (by the `RESERVED_SET` constant and `isReservedFieldKey` function). The only external consumers (`apps/api/src/team/contact-fields/contact-fields.service.ts:9` and `apps/web/src/app/(app)/settings/contact-fields/contact-fields-settings.tsx:20`) import only `isReservedFieldKey`.

**Why dangerous.** Public API surface that nobody uses — every additional export across the apps/web ↔ apps/api boundary is a contract the package owes, so the bigger the surface the higher the friction on any future refactor (e.g. moving slug normalization into a shared text helper). Note `field-tokens.ts`'s "legacy 2-deep" exports are NOT this case — those ARE actively used (memory note: don't flag).

**Impact.** None today. Hygiene only.

**Fix.** Drop the `export` keyword from both `RESERVED_FIELD_KEYS` and `normalizeFieldKey` (keep them module-private). If a real outside consumer later needs them, re-export at that point.

**Verifier note.** Verified by grep across the repo:
- `RESERVED_FIELD_KEYS` exported at packages/shared/src/contacts/reserved-fields.ts:11 — consumed ONLY at line 53 of the same file (`const RESERVED_SET = new Set(RESERVED_FIELD_KEYS)`).
- `normalizeFieldKey` exported at line 60 — consumed ONLY at line 70 of the same file (inside `isReservedFieldKey`).
- Repo-wide grep for `RESERVED_FIELD_KEYS|normalizeFieldKey` returns zero external hits (only the in-file declarations + uses).
- Repo-wide grep for `isReservedFieldKey|reserved-fields` confirms the only external consumers (apps/api/src/team/contact-fields/contact-fields.service.ts, apps/web/src/app/(app)/settings/contact-fields/contact-fields-settings.tsx) import only `isReservedFieldKey`.

The finder's factual claim is accurate. Severity Low is appropriate (hygiene only, no runtime/security/correctness impact). The proposed fix (drop `export`) is safe — neither symbol is dynamically resolved and TypeScript would catch any cross-package import at compile time. One nuance worth noting: the file header comment claims the list "Stays in shared/ so the CSV import header recognizer and the Zod schemas can both reference the same list" — suggesting authorial intent to expose `RESERVED_FIELD_KEYS`. But that aspirational consumer doesn't exist today, so the finding is correct that the export surface is unused. Standing finding at Low.


## L15. Customer-side custom-fields search ILIKEs JSONB::text per row in listContacts
_Database / Prisma / queries / migrations_ · `apps/api/src/lib/queries/contacts.ts:111-118`

**Problem.** listContacts' search branch concatenates a raw SQL clause: `OR c."customFields"::text ILIKE '%query%'` (apps/api/src/lib/queries/contacts.ts:115-117). Casting JSONB to text and ILIKE-substringing it can't use the existing `Contact_customFields_gin_idx` (jsonb_path_ops only serves containment/`@>` queries, not text substring) — every page of the contacts list with a search term forces a per-row JSONB-to-text projection + substring scan on top of the cursor scan, even though the GIN index exists.

**Why dangerous.** Searching by an arbitrary substring on contacts is the headline interaction in the contacts UI. Past ~10k contacts the search-bar typing latency becomes noticeable (debounced per-keystroke query). The GIN index is doing nothing for this path — it's bytes on disk with no read serving them.

**Impact.** Search UX degrades smoothly as contact count grows. Not a correctness issue; not a hard cliff. Hits at the same scale as Broadcast/audience pain (10-50k contacts).

**Fix.** Either (a) drop customFields from the generic search-bar and require the explicit fieldFilter branch (which keys by specific field via `c."customFields" ->> key ILIKE ?` and is also unindexed but cheaper because of single-field projection), or (b) add a Postgres GENERATED-COLUMN text projection plus a pg_trgm index over it (heavier migration). Quick win: only execute the customFields::text ILIKE branch when the team has <5k contacts (check via the existing countContacts pattern), otherwise skip it from the OR clause.

**Verifier note.** Verified the citation: apps/api/src/lib/queries/contacts.ts:116 does `c."customFields"::text ILIKE ${"%" + search + "%"}` exactly as claimed. The `Contact_customFields_gin_idx` (prisma/migrations/0_init/migration.sql:827) is `jsonb_path_ops` GIN, which serves containment (@>) / existence (?, ?|, ?&) operators only — it cannot serve `::text ILIKE`. The planner therefore cannot use it for this branch. Even though `Contact.name` and `Contact.phoneNumber` have trgm GIN indexes (lines 829, 831), the unindexed `customFields::text` and `email` branches in the OR clause force the planner into a per-row scan across the team's contact set.

However, the finding overstates impact for current pilot scale:
1. It fires only when a `search` term is present, not on plain list loads.
2. It is scoped to a single team via `WHERE c.teamId = ${teamId}`, so the cost is bounded by per-tenant contact count, not the global Contact table.
3. The finder itself admits "Past ~10k contacts" and "Hits at the same scale as Broadcast/audience pain (10-50k contacts)" — that's exactly the "10k+" cliff CLAUDE.md explicitly lists under "Scaling cliffs to anticipate (don't pre-build)."
4. The author's own header comment (lines 27-29) acknowledges this is a deliberate "cast to text + ILIKE so partial matches work" compromise.
5. `email` has the same unindexed-ILIKE problem; customFields is not uniquely at fault.

The proposed "drop customFields from the search bar" fix would silently remove a feature; the "generated column + trgm index" fix is the right long-term move but is a heavier migration. The "count-gated branch" quick win adds a synchronous countContacts per keystroke that may itself be costlier than the seqscan.

Net: the technical claim stands but Medium feels overstated for pilot scale where CLAUDE.md has already marked 10k+ scaling work as deferred. Revising to Low.


## L16. Nightly pg-backup cron is set up manually — silent total backup failure on fresh VPS
_Deployment / production / docker / migrations_ · `scripts/pg-backup.sh + .github/workflows/deploy.yml:570 (installs script but never validates cron)`

**Problem.** deploy.yml:570 installs `/opt/ccp/pg-backup.sh` on every deploy, but the cron line that invokes it (`17 3 * * * cd /opt/ccp && ./pg-backup.sh ...`) is set up MANUALLY once per VPS, documented in deploy/README.md:454. There's no validation step in the deploy workflow that asserts the cron is present, and no exit-code check on the backup script anywhere.

**Why dangerous.** A fresh VPS deploy succeeds with no backups configured. The script is also a silent fail — pg-backup.sh:37 only exits 1 when the dump is <10KB, but if cron itself isn't installed the script never runs at all. There's no "last backup older than N hours" monitor.

**Impact.** On a first-deploy or post-VPS-replacement scenario, the operator believes backups are running because the script is installed. First disaster reveals no backups exist. Data loss = total — there's no offsite copy mentioned as required, only suggested at deploy/README.md:475.

**Fix.** Add a `Validate backup cron` step to the ship job that SSHes and runs `crontab -l | grep -q pg-backup.sh || (echo "✗ pg-backup cron missing"; exit 1)`. Soft-fail (warning) on first deploy, hard-fail on subsequent. Better: have the deploy workflow IDEMPOTENTLY install the cron line itself the same way it installs the script — `( crontab -l 2>/dev/null | grep -v pg-backup.sh; echo '...' ) | crontab -`. Add a `freshness` check: backups dir should have a file <26h old; fail loud if not.

**Verifier note.** The finding is factually accurate at the code level: deploy.yml:570 only installs the script (`install -m 0755 /tmp/ccp-deploy/pg-backup.sh /opt/ccp/pg-backup.sh`) and never installs the cron. README.md:454 documents the cron as "One-time setup on the VPS." pg-backup.sh:37 only exits 1 on <10KB dumps. So the description is technically correct.

However, this is a CONSCIOUS, RECORDED decision from the 2026-05-26 pre-deploy audit, captured in memory at /home/aliubuntu/.claude/projects/-home-aliubuntu-projects-loadless-projects-customer-communication-platform/memory/project_predeploy_audit_2026_05_26.md:22 ("Cron line is one-time setup on the VPS — see the README") and indexed in MEMORY.md with the explicit guard "Re-read code before re-litigating these." The verifier rules say to drop findings that are "already noted in CLAUDE.md as 'intentional/locked/deferred'" — this fits that pattern: the audit identified the missing-backup risk, the fix was applied (script + docs), and the cron-line-is-manual is the recorded operational seam, not an oversight.

Operational scale also undercuts severity. Pilot is 1 customer; the operator who set up the VPS is the same person reading the runbook. There is no fresh-VPS deploy scenario in flight — VPS exists and the cron was set up once by the operator on 2026-05-26 as documented. The "first-deploy" failure mode the finder describes only bites on a VPS REPLACEMENT, which is a rare DR event covered by the runbook.

The proposed fix (idempotent `( crontab -l 2>/dev/null | grep -v pg-backup.sh; echo '...' ) | crontab -` in the deploy script) is technically reasonable and not unsafe. But adopting it overrides an explicit human decision recorded with the "don't re-litigate" guard. If the finding is kept at all, severity is Low (documented runbook gap on a rare DR path), not Medium.

Verdict: partial — the underlying observation is real but the finding re-litigates a settled call and overstates severity given the documented decision + 1-customer pilot scale.


## L17. Required GH secrets validation misses POSTGRES_DB / POSTGRES_USER / BETTER_AUTH_URL
_Deployment / production / docker / migrations_ · `.github/workflows/deploy.yml:105-108 (missing POSTGRES_DB, POSTGRES_USER from the fail-fast list)`

**Problem.** deploy.yml:105-108 enforces non-empty for 13 secrets (ENCRYPTION_KEY, BETTER_AUTH_SECRET, INTERNAL_BUS_SECRET, POSTGRES_PASSWORD, UPLOADTHING_TOKEN, APP_DOMAIN, ADMIN_EMAIL, HEALTHCHECK_URL, DOCKER_USERNAME, DOCKER_PASSWORD, VPS_HOST, VPS_USER, VPS_SSH_KEY). But the ship step (deploy.yml:541-543) renders /opt/ccp/.env with `POSTGRES_DB=${POSTGRES_DB}` and `POSTGRES_USER=${POSTGRES_USER}` with no fallback. compose has `${POSTGRES_USER:-app}` but that default fires only when UNSET, not when empty — an empty secret renders an empty value and postgres rejects it.

**Why dangerous.** Smoke catches POSTGRES_USER/DB missing (postgres fails to start), but only after burning ~3min of CI. The fail-fast list exists precisely to surface these in the first 2s.

**Impact.** Slow feedback on a misconfig; not a runtime hazard at steady state.

**Fix.** Append `POSTGRES_DB POSTGRES_USER` to the `for v in ...` list at deploy.yml:105. Optionally also `BETTER_AUTH_URL` (rendered from APP_DOMAIN so derivable, but explicit checks are cheap).

**Verifier note.** Verified at exact lines cited.

CODE MATCHES: deploy.yml:105-107 fail-fast list contains 13 names (ENCRYPTION_KEY, BETTER_AUTH_SECRET, INTERNAL_BUS_SECRET, POSTGRES_PASSWORD, UPLOADTHING_TOKEN, APP_DOMAIN, ADMIN_EMAIL, HEALTHCHECK_URL, DOCKER_USERNAME, DOCKER_PASSWORD, VPS_HOST, VPS_USER, VPS_SSH_KEY) — POSTGRES_DB and POSTGRES_USER are NOT in the list. deploy.yml:509-510 pulls them from secrets.* (could be empty). deploy.yml:541-542 renders them into /opt/ccp/.env with bare `${POSTGRES_DB}` / `${POSTGRES_USER}` heredoc substitution.

FAILURE MODE PARTIALLY WRONG: The finder claims "compose ${POSTGRES_USER:-app} fires only when UNSET, not when empty — empty renders empty value and postgres rejects it." That's incorrect — in both Bash and Docker Compose, `${VAR:-default}` (with the colon) DOES substitute the default for empty values; `${VAR-default}` (no colon) is the unset-only form. docker-compose.yml:85-86 uses `${POSTGRES_DB:-ccp}` / `${POSTGRES_USER:-app}`, so an empty .env line would actually fall through to the defaults. Postgres would NOT reject — it would silently boot with database `ccp` / user `app`.

REVISED FAILURE MODE: The real risk is the OPPOSITE — silent fallback to default credentials when the operator INTENDS specific values. A misconfigured secret means prod runs on `app:${POSTGRES_PASSWORD}@postgres/ccp` instead of the intended `myuser:...@postgres/mydb`. DATABASE_URL on web/api (lines 188, 305) uses the same `:-` defaults, so the app would connect successfully to a database that may not exist or be empty/migrated. On a fresh prod install this would cause Prisma to fail at migrate-apply, on an established install this would surface as auth-against-wrong-user (real failure but with a misleading error). Either way the fail-fast list at line 105 is the right surface to catch it in 2s.

SEVERITY ASSESSMENT: Low is correct. Real prod-deploy bug class, but only bites on initial setup when secrets are first added — once set, they stay set across deploys. Catches at CI-time vs ~3min into smoke. Not a runtime hazard.

FIX EVALUATION: The proposed fix (append `POSTGRES_DB POSTGRES_USER` to the for-loop) is correct and safe — purely additive validation, no behavior change for the happy path. BETTER_AUTH_URL is derived from APP_DOMAIN (line 546) so doesn't need adding.

NOT IN locked-decisions / deferred lists. The deploy.yml comments at lines 114-120 explicitly chose to KEEP the fail-fast list (dropped ENABLE_DEV_TOOLS / INTEGRATIONS_ALLOW_PRIVATE_HOSTS, but the goal of the list is exactly this kind of pre-flight check).

Confirming the finding, but the why_dangerous wording is partially wrong: the actual blast radius is silent fallback to default `app/ccp` credentials, not "postgres rejects empty value". Severity (Low) and fix are right.


## L18. docker-compose.yml line 53 comment about pool sizes is stale (says api max=25, code is 50)
_Deployment / production / docker / migrations_ · `docker-compose.yml:50-53 vs apps/api/src/db/db.service.ts:60`

**Problem.** docker-compose.yml:50-53 documents `work_mem: 8MB × 35 pool slots = 280MB worst case` based on `(api max=25 + web max=10)`. The actual api pool is now max=50 (apps/api/src/db/db.service.ts:60), so worst-case work_mem is 8MB × 60 = 480MB, and total api+web+ad-hoc connections can reach 60 against postgres max_connections=120 — still well under the cap, but the tuning rationale documented in the compose file is wrong.

**Why dangerous.** Future operator reading the comment and re-tuning shared_buffers/max_connections based on the stale 35-slot premise will undersize.

**Impact.** Documentation drift only — no immediate runtime impact. Becomes load-bearing during the next "why is postgres slow" debug session.

**Fix.** Update the comment in docker-compose.yml to say `api max=50 + web max=10 = 60` and re-derive the 8MB×60 = 480MB worst-case. Optionally bump max_connections from 120 → 150 to keep the ad-hoc connection headroom the old comment described.

**Verifier note.** Verified both citations against the actual code:

1. docker-compose.yml:50-53 says: `work_mem: 8MB × 35 pool slots = 280MB worst case` and `api max=25 + web max=10 = 35`.
2. apps/api/src/db/db.service.ts:60 actually sets `max: 50` (with detailed justification in the surrounding comment for why it was raised from 25 to 50).
3. apps/web/src/lib/db.ts:29 sets `max: 10` (unchanged).

The drift is real: the compose-file comment was written when api pool was 25, and the api pool has since been raised to 50 with its own correct documentation, but the cross-reference in compose wasn't updated. Worst-case work_mem is now 8MB × 60 = 480MB, still well under the 1.5GB mem_limit, so there is no runtime impact today.

Severity Low is correct per the project's severity guide ("cleanup / smell, defer-friendly"). The failure mode (future operator re-tunes Postgres based on stale 35-slot premise) is plausible but minor and only becomes load-bearing during a future debugging session. The fix (update the comment) is safe and trivially low-risk.

Not "intentional/locked/deferred" anywhere in CLAUDE.md or memory.

Finding stands as-is.


## L19. Ship step doesn't validate the shipped docker-compose.yml before applying it
_Deployment / production / docker / migrations_ · `.github/workflows/deploy.yml:568-606`

**Problem.** deploy.yml:568-569 moves the new docker-compose.yml into /opt/ccp/ and then immediately runs `docker compose --env-file .env pull` + `up -d` (line 605-606). Caddy's config has a `caddy validate` gate at line 591, but compose has no equivalent — a malformed YAML or unresolvable variable causes the live `up -d` to fail with the stack in an inconsistent state.

**Why dangerous.** Compose-side syntax error mid-deploy can leave the existing services partially recreated. A `docker compose config -q` against the new file catches malformed YAML or missing env vars in <1s before touching the live containers.

**Impact.** Rare (CI typecheck already runs against the compose file via the smoke `docker compose up` in a previous step), but the smoke uses a synthetic .env not the prod-rendered one — a typo in the SSH-side heredoc rendering would slip through.

**Fix.** Insert `docker compose --env-file .env config -q` between the mv at line 568 and the pull at line 605. Bail with non-zero if it errors, before `up -d` recreates anything.

**Verifier note.** The code citation is accurate: line 568 `mv` moves the compose file, line 591 has the Caddy `validate` gate, and lines 605-606 run `pull` + `up -d` with no `docker compose config -q` check in between. So the literal claim is technically correct.

However, the finder's stated failure mode is essentially unreachable:

1. The earlier smoke-test step (lines 386-471) runs `docker compose --env-file .env pull` + `up -d` against the EXACT compose file that gets shipped (copied via `cp docker-compose.yml _deploy/docker-compose.yml` at line 333, then tar'd into the artifact at line 348). A `docker compose up -d` is a strictly stronger gate than `docker compose config -q` — malformed YAML or unresolvable variables fail `up -d` instantly, and the smoke step also boots the stack, runs migrations, and probes `/health` for `ok:true`.

2. The finder's claim that "the smoke uses a synthetic .env not the prod-rendered one" is FACTUALLY WRONG. Lines 354-384 show the smoke .env uses the SAME `${{ secrets.* }}` values (POSTGRES_DB, BETTER_AUTH_SECRET, ENCRYPTION_KEY, INTERNAL_BUS_SECRET, UPLOADTHING_TOKEN, APP_DOMAIN) as the SSH-side .env render at lines 540-560. The comment at line 352-353 explicitly says "Real secrets are used so the smoke test catches any value-specific issues". The only difference is the file is rendered runner-local vs ssh-side, but it's the same set of resolved secrets.

3. The proposed fix (`docker compose config -q` between lines 568 and 605) would only catch unresolved `${VAR}` references in the SSH-side .env heredoc that differ from the smoke-side .env heredoc. Both heredocs are in the same file ~200 lines apart and read from the same `secrets.*` namespace — divergence is caught by code review of a single PR.

4. The finder already self-rated this as Low and acknowledged it's "Rare". Given the smoke-test boot already provides a structurally stronger gate, the Low severity is even defensible-to-overstated.

This is a real but vanishingly small gap. Marking as partial with severity unchanged at Low — the cleanup is harmless to apply but the failure mode is nearly impossible given the existing smoke-boot gate.


## L20. Realtime-tier async rejection isn't recorded in the outbox `lastError`
_Error handling / reliability_ · `apps/api/src/lib/events/bus.ts:227-253`

**Problem.** In `runSubscribers` (apps/api/src/lib/events/bus.ts:229-253), when the lowest-tier subscriber is REALTIME, its handler is fired fire-and-forget. A SYNCHRONOUS throw is caught and pushed into `errorSink`. But a Promise rejection (the `if (maybe && .then) { void (maybe).catch(...) }` branch at line 233-244) is logged via console.error only. The comment at line 240-242 explicitly states: 'this branch runs AFTER runSubscribers resolved; the sink isn't read anymore. The error stays in stdout.' For drainer-dispatched events (via `dispatchPersistedEvent`) this means a realtime subscriber that fails asynchronously is invisible in the `OutboundEvent.lastError` forensic surface — the row looks delivered cleanly.

**Why dangerous.** Today the realtime subscribers in `FANOUT_RULES` only call `emitter.emitTo*()` which warn-and-drop and never throw, so this hazard is dormant. If a future fanout rule does an async lookup (e.g. the existing buildVisibleViewers-style pattern hoisted into a fanout rule) and that throws asynchronously, the failure becomes a stdout-only ghost. Operators querying OutboundEvent.lastError would conclude the system is healthy when realtime emits were quietly failing.

**Impact.** Forensic surface gap. Bites only after a future code change introduces an async-rejecting realtime handler. Low until then.

**Fix.** Capture the async-rejection into `errorSink` BEFORE returning from `runSubscribers`. Since runSubscribers can't `await` the fire-and-forget realtime promise (that defeats the point), an alternative is to require realtime handlers be strictly synchronous via the type — narrow the bus `Handler<K>` so REALTIME-tier registrations can only return `void`, not `Promise<void>`. This makes the async-rejection branch dead by construction. Or accept the gap and add a one-line code comment in `FANOUT_RULES` explaining realtime handlers MUST be synchronous (the type assertion would be safer).

**Verifier note.** Verified the code at apps/api/src/lib/events/bus.ts:204-274 — it matches the finding's claim exactly. Lines 229-253 implement the realtime fire-and-forget branch; line 234 attaches `.catch(...)` that only console.errors and explicitly does NOT push to errorSink. The comment at lines 240-242 acknowledges this gap ("the sink isn't read anymore. The error stays in stdout — same posture as before.").

Checked reachability: Handler type at fanout-rules.ts:59-62 permits `void | Promise<void>`, and RealtimeFanoutService.registerSubscribers casts to a void-returning handler but doesn't enforce it at runtime. Currently zero rules in FANOUT_RULES are async (grep confirms no async/await/Promise in rule bodies), so the failure mode is dormant — exactly as the finder stated.

CLAUDE.md and memory: not listed as intentional/locked/deferred. The bus event-architecture audit memory entry (project_event_architecture_audit_2026_05_25) doesn't call this out.

Severity assessment: the finder marked Low, which is defensible — it IS a forensic surface gap that bites only after a future code change. The code already contains an acknowledging comment, which moves this into "documented trade-off" territory. The fix the finder proposes ("narrow Handler<K> so REALTIME-tier returns void only") would actually be a small structural improvement (impossible-by-construction is better than impossible-by-convention), and the alternative they offer ("add a code comment") already exists.

I'd call this "partial" — the finding is factually correct but borderline noise: dormant condition, acknowledging comment in place, type-narrowing nit. The actual user-facing impact is zero today, and the proposed fix is a developer-ergonomics improvement, not a reliability fix. Low severity is right for what it is, but it sits near the threshold of "should not be surfaced" per the rule "Be ruthless: if it is correct, say nothing." Confirming at Low since the technical claim is verifiable and the fix is sound.


## L21. Outbox-drainer `inFlight` re-entry guard schedules a duplicate tick
_Error handling / reliability_ · `apps/api/src/events/outbox-drainer.service.ts:120-127, 189-192`

**Problem.** In `OutboxDrainerService.tick()` (apps/api/src/events/outbox-drainer.service.ts:120-127), if the previous tick is still running when the timer fires, the code calls `this.schedule()` and returns. But `tick` is also called from the timer (line 115-117), so the schedule call effectively re-arms a NEW timer while the original tick is still in-flight. When the in-flight tick completes, its `finally` block (line 189-192) calls `this.schedule()` AGAIN — leaving two timers chained. Over time under load, the drainer can develop multiple parallel timer chains.

**Why dangerous.** Each scheduled `setTimeout` chains another at the end of the next tick. If two ticks race (rare under normal load but possible during burst dispatch), both will keep re-scheduling. The `inflight` guard correctly prevents concurrent dispatch, but the timer chains multiply. Each extra chain costs a 100ms poll worth of wasted work (cheap claimBatch query) plus the closure retention overhead.

**Impact.** Wasted DB poll queries (one cheap `claimBatch` per orphan timer chain). Doesn't cause correctness bugs because `inflight` blocks concurrent dispatch. Cumulative cost is minor (each extra chain = 10 cheap queries/sec) but indefinite — chains never collapse back to one.

**Fix.** Remove the `this.schedule()` call at line 125. The currently-running tick's `finally` block already re-schedules when it completes — so the re-entry path doesn't need to also schedule. Effectively: `if (this.inflight) return;` instead of `if (this.inflight) { this.schedule(); return; }`. The original tick handles re-arming.

**Verifier note.** The cited code matches what the finder claims (lines 113-127, 189-192 of /home/aliubuntu/projects/loadless_projects/customer-communication-platform/apps/api/src/events/outbox-drainer.service.ts). The finder is correct that the re-entry guard at line 125 calls `this.schedule()` AND the `finally` block at line 191 also calls `this.schedule()`, so IF the guard ever fired, two parallel timer chains would result.

However, the failure mode the finder describes is unreachable under current architecture:
- `tick()` is only ever invoked from the timer armed by `schedule()` (line 116). No external caller exists (confirmed by grep across apps/api/src).
- `schedule()` is called from three places: `onModuleInit` (once), the re-entry guard, and the `finally` block.
- During a normal tick's execution, NO call to `schedule()` happens until `finally` runs.
- In `finally`, `this.inflight = false` is set BEFORE `this.schedule()` is called (lines 190-191). So by the time the next timer fires (~100ms later), `inflight` is already false.
- Therefore the re-entry guard at line 122 is dead defensive code under normal flow — it cannot fire because there is never a second timer racing with an in-flight tick.

The finder's claim that "during burst dispatch" two ticks could race is incorrect: burst dispatch makes tick A take longer, but the next timer is still only armed by tick A's own `finally`, which runs after `inflight = false`.

The proposed fix (removing the `schedule()` call from the re-entry guard) is a benign cleanup. But:
1. The bug described (parallel timer chains accumulating under load) cannot occur.
2. The fix removes a `schedule()` call from a code path that is itself unreachable, so it changes nothing observable at runtime.
3. The defensive code is harmless dead code, not an active bug.

Verdict is "partial" because the static code observation (two schedule() calls if guard fires) is correct, but the impact/failure-mode framing is wrong — the guard is unreachable in current architecture, so no chains can multiply. Severity stays Low (it's a defensive-code-cleanup smell at best, no user-visible behavior).


## L22. Outbox drainer can lose rows when stop_grace_period exhausts before 25s flush deadline
_Error handling / reliability_ · `apps/events/outbox-drainer.service.ts:89-111 vs apps/api/src/workflows/workflow-worker.service.ts:263-366`

**Problem.** OutboxDrainerService.onModuleDestroy waits up to 25 seconds for in-flight dispatches to drain (apps/api/src/events/outbox-drainer.service.ts:106). But the api service's `stop_grace_period` is 100s (docker-compose.yml:441), and `OnModuleDestroy` hooks run SEQUENTIALLY. Earlier hooks (sweeper stops are quick, but `stopWorkflowWorker` waits up to 85s for BullMQ to drain) can consume most of the budget before OutboxDrainerService.onModuleDestroy is even invoked. If the workflow worker drain takes its full 85s, the drainer has only 15s of real budget left — less than the 25s it expects.

**Why dangerous.** If main.ts's `process.exit(0)` line fires before drainer finishes, in-flight outbox rows have ALREADY been marked `publishedAt` by claimBatch but their subscribers never completed dispatch. At-most-once semantics says we accept the loss, but the loss is silent (no `lastError` stamped) — operators querying OutboundEvent.lastError for failures will see clean publishedAt rows for events whose webhooks/workflows never ran. Mostly a concern under a deploy storm where workflow drain saturates.

**Impact.** Silent dispatch loss on shutdown under specific conditions (slow workflow drain + busy outbox). Forensically invisible. Bites only when a deploy lands during a workflow burst.

**Fix.** Reorder NestJS module-init so OutboxDrainerService stops BEFORE WorkflowWorkerService — drainer first, workers after. Then drainer's full 25s budget is available before workflow drain begins. Concretely, declare OutboxDrainerService AFTER WorkflowWorkerService in the parent module's `providers` array (NestJS destroys in reverse-init order, so later-declared = earlier-destroyed). Alternatively, on shutdown, mark drainer.stopping = true synchronously from main.ts's SIGTERM handler so it stops claiming new batches well before app.close() runs.

**Verifier note.** Verified the cited code at /home/aliubuntu/projects/loadless_projects/customer-communication-platform/apps/api/src/events/outbox-drainer.service.ts (the finding's path "apps/events/..." is a typo; the line numbers 89-111 do match). The 25s flush deadline (line 106) and `this.stopping` semantics (line 90, 121, 132) are exactly as described.

Verified the failure mechanism is reachable:
1. NestJS module-destroy iteration is SEQUENTIAL across modules (`@nestjs/core/nest-application-context.js:259-266`: `for (const module of modulesSortedByDistance) { await callModuleDestroyHook(module) }`). Within a single module, providers' onModuleDestroy fires via Promise.all, but cross-module ordering is awaited one at a time, reverse-distance.
2. WorkflowsModule depends on EventBus (global), so WorkflowsModule is at greater distance than EventBusModule. Reversed = WorkflowsModule destroys FIRST, EventBusModule (containing OutboxDrainerService, event-bus.module.ts:47) destroys LATER.
3. stopWorkflowWorker (apps/api/src/lib/workflows/worker.ts:239) caps at 85s. main.ts's server.close has a 3s budget (main.ts:350). docker-compose api stop_grace_period is 100s (docker-compose.yml:441). Worst case 3 + 85 + 25 = 113s > 100s = SIGKILL during the drainer's flush window.
4. Loss is silent: claimBatch pre-marks publishedAt before dispatch, so if process exits mid-Promise.all (line 173), those rows have publishedAt set but no lastError stamp — operators querying OutboundEvent.lastError see clean rows for events whose subscribers never ran (audit row absent, outbound-webhook enqueue skipped, etc.).

Severity is correctly Low because:
- The drainer KEEPS WORKING during the 85s workflow drain (this.stopping is set only when onModuleDestroy fires, so the setTimeout-driven tick continues to claim+dispatch batches throughout the workflow drain). By the time onModuleDestroy is finally invoked, the outbox has been actively drained for ~85s; only a batch claimed in the last fraction of a second before destroy fires is at risk.
- Workflow drain rarely takes the full 85s in practice; the 113s worst case requires a deploy landing exactly during a stuck workflow job AND a busy outbox AND a fresh batch in-flight at the moment of drainer destroy.
- At-most-once semantics is documented and intentional (lines 30-34 of the drainer); loss is a known property of the design, not a bug.

Note on the proposed fix: the finder's primary suggestion — "declare OutboxDrainerService AFTER WorkflowWorkerService in the parent module's `providers` array" — is incorrect mechanically. They're in DIFFERENT modules (event-bus.module vs workflows.module), and even if they shared a module, NestJS calls within-module destroys via Promise.all (not sequentially in declaration order, per @nestjs/core/hooks/on-module-destroy.hook.js callOperator). The finder's ALTERNATIVE fix — synchronously setting `drainer.stopping = true` from main.ts's SIGTERM handler before app.close() — is correct and minimally invasive: it lets the drainer flush in parallel with the workflow drain instead of strictly after it. That's the actionable improvement.


## L23. Most /v1 mutation routes don't accept X-CCP-Depth — partner loop guard incomplete
_Integrations / inbound + outbound webhooks / API keys_ · `apps/api/src/external/v1/external-v1.controller.ts:193-516 (contact/conversation mutation handlers; only sendMessage, sendTopLevelMessage, createNote, bulkAddTags, bulkRemoveTags currently parse @Headers('x-ccp-depth'))`

**Problem.** Only POST /v1/conversations/:id/messages, POST /v1/messages, POST /v1/conversations/:id/notes, POST /v1/contacts/tags/add, and POST /v1/contacts/tags/remove read x-ccp-depth. The rest of the mutating surface — POST /v1/contacts, POST /v1/contacts/upsert, PATCH /v1/contacts/:id, DELETE /v1/contacts/:id, POST /v1/contacts/:id/tags, DELETE /v1/contacts/:id/tags/:tagId, POST /v1/contacts/:id/tags/remove, POST /v1/conversations/:id/assign, POST /v1/conversations/:id/status, POST /v1/contacts/:id/assign, POST /v1/contacts/:id/status — accepts no chain-depth header, so the controller never threads it into the service and the MAX_CHAIN_DEPTH cap never trips.

**Why dangerous.** Every one of those mutations fans out an outbound webhook (contact.created / contact.updated / contact.tag_changed / contact.lifecycle_changed / contact.deleted / conversation.assigned / conversation.status_changed). A partner whose receiver POSTs the same mutation back into /v1 — exactly the hot-potato pattern the X-CCP-Depth design is meant to break — will sustain a per-key loop until the 60-req/min/key bucket catches up. The X-CCP-Origin-Key check only catches the SAME-key case; a partner using a different key for ingress vs the egress webhook subscription escapes that loop guard entirely. The single-message paths defended this surface; the surrounding ones didn't.

**Impact.** One mis-built partner integration burns the team's full 60/min budget on a hot-potato loop forever, starving every other partner integration on the same key, and writes hundreds-of-thousands of OutboundWebhookDelivery + audit rows per day until manually disabled.

**Fix.** Add @Headers('x-ccp-depth') xCcpDepth?: string to every mutation handler in ExternalV1Controller (createContact / upsertContact / updateContact / deleteContact / addContactTags / removeContactTag / removeContactTags / assign / setStatus / assignByContact / setStatusByContact), thread parseChainDepth(xCcpDepth) into the corresponding ExternalV1Service / ExternalV1MessagingService methods, and gate at the top with the same `if (chainDepth !== undefined && chainDepth >= MAX_CHAIN_DEPTH)` 429 already used in sendMessage / bulkContactTags / createNote. The lib helper already exists (apps/api/src/lib/workflows/events.ts: parseChainDepth + MAX_CHAIN_DEPTH); this is pure wiring.

**Verifier note.** Mechanical claim is accurate: only sendMessage, sendTopLevelMessage, createNote, bulkAddTags, bulkRemoveTags read X-CCP-Depth at apps/api/src/external/v1/external-v1.controller.ts (verified at the cited lines). The remaining /v1 mutation handlers (createContact / upsertContact / updateContact / deleteContact / addContactTags / removeContactTag / removeContactTags / assign / setStatus / assignByContact / setStatusByContact) accept no x-ccp-depth header and the corresponding service methods at external-v1.service.ts:128-145, 178-196, 325, 614, 810, 869, 930, 1009, 1077 don't accept a chainDepth argument. So the wiring inconsistency is real.

However, the finder's central failure mode — "partner relays our outbound webhook back to /v1, depth-cap should catch it" — is broken regardless of which /v1 routes parse the header, because the outbound-webhook worker at apps/api/src/lib/outbound-webhooks/worker.ts:317-341 does NOT stamp X-CCP-Depth on partner deliveries (only X-CCP-Event / X-CCP-Delivery / X-CCP-Signature / X-CCP-Origin-Key / X-CCP-Trace-Id). A partner blindly relaying the payload back has nothing to forward — parseChainDepth(undefined) returns 0 — so even on the already-wired sendMessage / createNote / bulk-tag routes, the depth cap never trips for this pattern. The actual defense for the same-key partner-relay loop is X-CCP-Origin-Key (api-key.guard.ts:166-176, which DOES extract changedByApiKeyId for contact/conversation events per worker.ts:610-628) plus the per-key 60/min bucket. The cross-key partner-relay loop the finder calls out as the residual gap is bounded by the same 60/min bucket regardless of header wiring.

Where the wiring inconsistency DOES matter: workflow http_request step (apps/api/src/lib/workflows/steps/http-request.ts:162) DOES stamp X-CCP-Depth, so a workflow → external system → /v1/contacts/:id/tags or /v1/conversations/:id/assign chain would not be capped, while a workflow → external system → /v1/messages chain is. That's a defense-in-depth gap with narrower impact than the finder's headline scenario, since it only triggers when (a) a workflow uses http_request and (b) the external system loops back into one of the contact/conversation /v1 routes. Severity Low (consistency / belt-and-suspenders) rather than Medium (hot-potato cost burn).

Verdict: partial. The wiring claim is correct, the failure-mode framing is incorrect (header isn't propagated by outbound webhook worker, so the depth guard can't catch the partner-relay loop on ANY route today), severity is overstated to Medium when it's really a Low defense-in-depth/consistency call. The proposed fix is harmless and the lib helpers already exist, but it doesn't accomplish what the finder claims.


## L24. Outbound-webhook subscriber's per-team channel cache is grow-only across teams + cached entries never expire on Team config edit beyond catalog scope
_Integrations / inbound + outbound webhooks / API keys_ · `apps/api/src/outbound-webhooks/outbound-webhooks.subscriber.ts:104-114 (invalidator only listens to team.catalog_changed)`

**Problem.** channelCache (apps/api/src/outbound-webhooks/outbound-webhooks.subscriber.ts:69) is a per-process Map keyed by `${teamId}:${channel}`. It's invalidated wholesale only on `team.catalog_changed` events. Edits to ChannelConnection rows (e.g. an admin marking a connection inactive, rotating phone_number_id, or adding a second channel) do NOT publish team.catalog_changed unless the admin route also fires it — and rolling team-config edits straight on the channel-connection table won't.

**Why dangerous.** After a channel rotation (e.g. customer reconnects with a new phone_number_id) the cache keeps the old WireChannelBase.id forever on this process, so every outbound webhook ships a stale channel.id until process restart. Partners that route on channel.id (the canonical block in the wire shape) silently dispatch to the wrong destination. Low because the rotation operation itself is rare at pilot scale.

**Impact.** Per-tenant; one team's stale channel id → wrong routing in their partner's switch statement. Bounded to one process; resolved on next restart.

**Fix.** Either (a) publish team.catalog_changed with scope='channel' on every ChannelConnection write (look at WhatsApp-settings update path), or (b) drop the cache and re-resolve per envelope — it's a single indexed lookup. Given resolveChannel is a single `findUnique` on `(teamId, channel)` with a 3-column select, dropping the cache is the simpler answer; the cache savings are negligible compared to the enrichment lookups above it.

**Verifier note.** The finding partially holds but the failure mode is mischaracterized:

CONFIRMED parts:
- Code at /home/aliubuntu/projects/loadless_projects/customer-communication-platform/apps/api/src/outbound-webhooks/outbound-webhooks.subscriber.ts:69 matches: `channelCache` is a per-process Map keyed by `${teamId}:${channel}` (line 442).
- Invalidator at lines 104–114 only listens to `team.catalog_changed`.
- WhatsApp settings writes (whatsapp.service.ts `updateConfig` line 274, `disconnect` line 310) do NOT publish `team.catalog_changed`. They only call `invalidateProviderConfig(teamId)` (a separate cache used by the send path).

REFUTED parts:
- The finder's headline example — "phone_number_id rotation → stale channel.id" — does NOT trigger the bug. The cached `WireChannelBase` only stores `{id, name, source, created_at}` (lines 458–465) where `id` is the `ChannelConnection.id` (cuid PK), `name`/`source` are derived from `channel` (the cache KEY), and `created_at` is the row's createdAt. `updateConfig` does an upsert keyed on `(teamId, channel)`, so on rotation the existing row's PK stays the same; `phoneNumberId` lives in `config` JSON which is NEVER cached here. None of the cached fields drift on a rotation.
- The genuine (but narrow) stale path is `disconnect` → re-connect (a new ChannelConnection row with a new cuid PK + new createdAt) without a `team.catalog_changed` in between. That's a rare admin path; the cache will be flushed by the next catalog mutation (tags/snippets/stages/contact-fields/audience-groups/members all publish it routinely).
- Marking a connection inactive: `isActive` isn't a cached field, so no drift. Adding a second channel: that's a fresh cache key, not staleness.

The code comment at lines 60–67 explicitly acknowledges grow-only-by-design and that wholesale eviction on catalog change is "sufficient since the only field we cache from the team row is the Meta phone number" — that comment is slightly out of date (the cached object no longer carries phoneNumberId), but the architectural posture (grow-only, narrow eviction) is intentional.

Severity Low is correct. The proposed fix (drop the cache) is reasonable but the practical exposure is tiny: pilot-scale, single-tenant, and even at multi-tenant scale the stale window is bounded by the next routine catalog mutation. Severity stays Low; verdict is partial because the dominant failure mode the finder cited is not actually a failure mode.


## L25. MessageThread timeline.sort() allocates 2 Date objects per comparison on every render
_Performance (frontend + backend + DB + sockets)_ · `apps/web/src/features/inbox/components/message-thread.tsx:754-803`

**Problem.** In `MessageThreadImpl`, the timeline `useMemo` builds a unified array of messages + notes + events + calls and sorts it with `new Date(a.data.timestamp).getTime() - new Date(b.data.timestamp).getTime()` (apps/web/src/features/inbox/components/message-thread.tsx:794-802). For a thread at the 500-message cap (MAX_THREAD_SLICE), one sort = O(N log N) ≈ 4,500 comparisons × 2 Date allocations = ~9,000 Date objects + 9,000 parseISO calls per memo re-evaluation. The memo deps are `[messages, notes, events, hasMoreOlder, data.calls]`, so every new message, every retried message, every status flip that triggers a `messages` array replacement, every note/activity/call addition, re-runs the sort.

**Why dangerous.** On a busy thread receiving bursts (broadcast acks → message:status RAF flushes → addOptimistic → message:new), the rebuild fires several times per second. The Date allocations are pure garbage for the GC. Symptomatically: a long thread tab pegs CPU and reduces send-bubble framerate during a broadcast or live customer typing back-and-forth.

**Impact.** Per-render CPU cost grows with thread length. Visible jank on the displayed thread once an agent has scrolled in older pages (slice reaches 500). One worker per active tab; doesn't affect server.

**Fix.** Two cheap fixes that compose: (1) Snapshot `Date.parse(entry.data.timestamp)` once per entry while building the unified array (store as `_ts` on the local object) so the comparator is integer subtraction. (2) Since each source array (messages, notes, events, calls) is already roughly sorted, a single linear merge would replace `.sort()` entirely — messages arrive append-only at the tail in the common case, and the pending-tail rule is a simple partition. Either fix drops the sort to O(N) with no Date allocations on the hot path.

**Verifier note.** Verified the code at /home/aliubuntu/projects/loadless_projects/customer-communication-platform/apps/web/src/features/inbox/components/message-thread.tsx:754-803. The cited code matches exactly:

```js
}].sort((a, b) => {
  const ap = isPending(a);
  const bp = isPending(b);
  if (ap !== bp) return ap ? 1 : -1;
  return (
    new Date(a.data.timestamp).getTime() -
    new Date(b.data.timestamp).getTime()
  );
});
```

Confirmed:
1. The memo deps `[messages, notes, events, hasMoreOlder, data.calls]` are correct — every status flip rebuilds `messages` (verified `applyMessageStatus` in thread-reducers.ts:118 does `prev.messages.slice()` → new ref) so the memo re-fires on every `message:status` event.
2. MAX_THREAD_SLICE = 500 verified (use-conversation-events.ts:388), so the upper bound is real.
3. Broadcast acks deliver bursts of message:status frames, RAF-coalesced — claim of "several rebuilds per second during a broadcast" is plausible.
4. The proposed fix (snapshot `Date.parse(entry.data.timestamp)` once when building the unified array, integer-subtract in the comparator) is safe, simple, and a strict win — no behavioral change, eliminates ~9k Date allocations per re-sort.
5. Not listed as intentional/locked in CLAUDE.md or memory. The `inbox_thread_not_virtualized` memory documents the 500-cap full timeline as DESIGN, which actually makes this hot path load-bearing — virtualization is not coming back, so the cap will keep biting.

Severity assessment: the finder labeled this Medium. I'd argue it's at the Low/Medium boundary — the failure mode is tab-local (one active thread per agent), only meaningfully bites at the 500-message cap (which requires scrolling older pages in), and the cost is GC pressure, not blocking work. But the broadcast-recipient-status-flood scenario does produce sustained re-sorts, and the fix is genuinely tiny and risk-free, so a thoughtful "Low" is also reasonable. Calling it Medium is defensible but slightly hot — I'd revise to Low. The proposed fix is strictly better than the current code (no worse failure mode introduced).

Finding stands but severity is slightly overstated.


## L26. `buildVisibleViewers` re-emit on availability flip = N synchronous DB reads per status change
_Performance (frontend + backend + DB + sockets)_ · `apps/api/src/realtime/emitter.service.ts:131-152 and apps/api/src/realtime/realtime.gateway.ts:281-302`

**Problem.** When a user toggles availability, `user.availability_changed`'s fanout rule (apps/api/src/realtime/fanout-rules.ts:466) calls `emitter.emitConversationViewersForUser(e.userId)`. The emitter walks every conversation that user is viewing and awaits `buildVisibleViewers(conversationId, teamId)` per conversation (apps/api/src/realtime/emitter.service.ts:143-150). Each `buildVisibleViewers` runs a fresh `db.user.findMany({ where: { teamId, id: { in: viewers } } })` (apps/api/src/realtime/realtime.gateway.ts:288-291). A user with 5 tabs viewing 5 different threads × every availability flip = 5 sequential-ish DB round-trips (`Promise.all` parallelizes, but still N concurrent reads). The same column read happens identically per call (`availabilityStatus`).

**Why dangerous.** Availability flips are common (away/back/busy) and the WS rate-limit guard on the client lets the user flip a few times a minute. On a 25-agent team where most agents have ≥2 viewed threads, one availability storm (lunchtime / EOD) becomes ~50 concurrent SELECTs on the user table for the same data. At pilot scale invisible; at growth scale this is the kind of subtle cost that puffs into a P95 spike.

**Impact.** Postgres load per availability flip = O(viewed_conversations). Latency-invisible until the team grows or someone toggles availability rapidly.

**Fix.** Resolve the user's own `availabilityStatus` once at the top of `emitConversationViewersForUser` (we already know which user changed and the new status from the event payload), then pass it into a batched `buildVisibleViewers` variant that filters in-memory for the rest of the team's viewers. Better yet, since the only change is THIS user's status, the per-conversation viewer list can be patched locally: if the user was the one who changed, just emit the same already-known viewer list filtered by the new status — no DB read at all.

**Verifier note.** Code at the cited locations matches the finder's description. `emitConversationViewersForUser` iterates each conversation the user is viewing and `Promise.all`s a snapshotter that, per conversation, does BOTH a `db.conversation.findUnique` (for teamId) AND a `db.user.findMany` for viewer availability. Reachable on every `user.availability_changed` event, no caching layer.

However the severity is overstated. Realistic blast radius at pilot (1 customer, <25 agents):
- Availability toggles are human-paced (a few per day per user, not per minute). The 300/min RateLimitGuard is a ceiling, not a probable workload.
- `conversationsViewedByUser` returns conversation rooms the user EXPLICITLY joined as a viewer — typically the single focused thread, not every cached snippet. Per-flip cost is usually 1-2 conversations × 2 indexed PK lookups.
- Postgres indexed PK lookups on a tiny `IN (viewers)` set are sub-millisecond and parallelize cleanly.
- CLAUDE.md's own scaling-cliff posture ("50-200 tenants: ...Fix when seen") covers this exact class of cost.

The proposed fix is also partially wrong: the user.findMany filters by `IN (viewers)` — multiple users, not just the one who changed. You can't just "filter the already-known viewer list by the new status" because OTHER viewers' statuses aren't cached anywhere. A correct local-patch would require maintaining an in-memory availability cache, which is a non-trivial change (cache invalidation across instances, etc.). At 1 customer, that's premature.

Verdict: Low. Real but cleanup-grade, defer-friendly, fits the existing "fix when seen" scaling-cliff posture.


## L27. Broadcast `bumpCounters` issues one Postgres write per recipient (~25/s) instead of batching
_Performance (frontend + backend + DB + sockets)_ · `apps/api/src/lib/broadcast-runner.ts:1090-1141`

**Problem.** `processOneRecipient` calls `bumpCountersFireAndForget` after every recipient (apps/api/src/lib/broadcast-runner.ts:853, 696, 719, 736, 806, 818). Each bump executes a separate `db.broadcast.update({ where: {id}, data: { sentCount: { increment } } })` (line 1090-1102) and the publish goes through the full bus to schedule the throttled progress emit. At SEND_CONCURRENCY=5 × ~25 msg/s, that's ~25 UPDATEs per second per running broadcast, each round-tripping to Postgres and competing for the row lock on the same Broadcast row.

**Why dangerous.** Row-lock contention on the broadcast row serializes the 5 lanes anyway — the increments are atomic at the DB level, but each UPDATE briefly holds the row lock, so the lanes queue behind one another even though the throttle only emits every 500ms. At 10k recipients that's ~10k UPDATEs to one row; even at low latency this is meaningful pool pressure for a single-VPS deploy. The progress emit is already throttled to 500ms; the DB write doesn't need to keep pace with sends.

**Impact.** Postgres pool pressure during large broadcasts. Pilot-fine; bites once a team runs a 5k+ broadcast on a shared single-process deploy. Doesn't risk correctness because the DB increment is authoritative regardless of emit cadence.

**Fix.** Buffer per-lane delta locally and flush every 500ms (the same cadence as the progress emit), or every K recipients. A single UPDATE with the accumulated `{ sentCount: { increment: K_sent }, failedCount: { increment: K_failed } }` per flush replaces ~25 writes/sec with ~2/sec while keeping the published progress identical.

**Verifier note.** Code matches the claim exactly: `bumpCountersFireAndForget` is called 6 times in `processOneRecipient` at apps/api/src/lib/broadcast-runner.ts:696, 719, 736, 806, 818, 853. Each call routes to `bumpCounters` (line 1090) which issues a real `db.broadcast.update({ where: {id}, data: { sentCount: { increment } } })`. SEND_CONCURRENCY=5 × ~200ms gap = ~25 sends/sec → ~25 UPDATEs/sec to one Broadcast row during a large broadcast. So the *factual* core of the finding stands.

However, the severity/framing has problems:

1. The "row-lock contention serializes the 5 lanes anyway" reasoning is wrong. Postgres holds the row lock only for the duration of the increment UPDATE itself (sub-ms on a single int column with HOT update), not anywhere close to the 200ms SEND_GAP_MS. The lanes are paced by SEND_GAP_MS and Meta latency, not by row-lock waits. 25 single-row HOT increments/sec is trivial Postgres load (orders of magnitude under capacity).

2. The "blast radius" is bounded by an existing hard cap. apps/api/src/lib/broadcast-runner.ts:93 enforces MAX_RECIPIENTS_IN_PROCESS = 10_000, so the worst-case bite is 10k UPDATEs over the broadcast's lifetime (~6 minutes at 25/sec), not an unbounded blow-up.

3. CLAUDE.md already explicitly defers this scaling cliff: under "Skip until forced to revisit" — "Move broadcast runner to a separate worker / BullMQ — only when a single broadcast crosses ~10k recipients OR a broadcast crashes the app mid-flight." The micro-optimization to batch counter bumps would be subsumed by that larger move; doing it standalone is cleanup, not a fix.

4. The proposed fix is not unsafe but the finder didn't address the `pendingBumps` drain invariant (broadcast-runner.ts:1121-1124 comment): the current per-recipient promise tracker is what guarantees `sentCount + failedCount === totalCount` before the row flips to `completed`. A flush-timer rewrite must preserve that, otherwise UIs watching for the `completed` transition can briefly observe incomplete totals.

Net: finding is factually accurate but overstated on the "row-lock contention" mechanism, and the impact severity is already correctly labeled "Low" by the finder, which matches an explicitly-deferred scaling cliff. The finding is real but covered by existing deferral posture; severity stays Low.


## L28. Conversation list query selects every column of `assignedUser` on a hot path
_Performance (frontend + backend + DB + sockets)_ · `apps/api/src/lib/queries/conversations.ts:211 (listConversations), 272 (getConversationWithRefs), 506 (listNewerMessages)`

**Problem.** `listConversations` includes `assignedUser: true` (apps/api/src/lib/queries/conversations.ts:211, 272, 506) which selects all User columns — including availabilityMessage (free-text up to 100 chars), emailVerified, createdAt/updatedAt, etc. The list payload only uses id, name, avatarUrl (the row's `Avatar` rendering reads avatarUrl + name). Every conversation row in the response drags the unused columns over the wire.

**Why dangerous.** At 30 rows × ~150 bytes of unused columns per row = ~4.5KB of dead payload per list response. On filter switches + reconnect resyncs + visibility-resync this fires several times per session per tab. Death-by-a-thousand-cuts, not a single hotspot.

**Impact.** Wire size and JSON parse cost. Tiny per request but every connected tab pays it on every filter/refetch.

**Fix.** Switch the three `assignedUser: true` sites to an explicit `select: { id: true, name: true, avatarUrl: true }` (the contact include block already follows this pattern, line 187-209). Mirrors the same justification the comment at line 182 makes for narrowing `contact` selects.

**Verifier note.** Verified: the three `assignedUser: true` includes exist at the cited lines (211, 272, 506 in apps/api/src/lib/queries/conversations.ts) and Prisma's default include semantics do select all scalar User columns, so the query pulls every column (teamId, email, emailVerified, createdAt, updatedAt, deactivatedAt, availabilityStatus, availabilityMessage, role, image/avatarUrl, etc.) on three hot paths. The inbox list UI confirms minimal usage of assignedUser — `conversation-list-item.tsx:144-150` reads only `assignedUser.id` (avatar seed) and `assignedUser.name` (initials + first-name label); availability is rendered only for the current user (app-rail / availability-picker), never for assignees on inbox rows.

However, the finder's impact framing is partially wrong on a load-bearing detail: the BROWSER wire payload is already narrowed by `mapUser` in apps/api/src/lib/queries/_shared.ts:74, which only emits `{ id, teamId, role, name, email, avatarUrl, createdAt, isActive, availabilityStatus?, availabilityMessage? }` and explicitly strips `emailVerified`, `image`, password hash columns, `updatedAt`, etc. So the "~4.5KB of dead payload per list response over the wire" and "JSON parse cost" framing overstates the cost: the over-selection only inflates the Postgres → Node socket transfer and the in-Node Prisma row construction — NOT the JSON delivered to the browser. The actual win from the proposed fix is mostly DB-side: smaller row buffers, faster Prisma deserialization, no `availabilityMessage` 100-char free-text on `getConversationWithRefs` or `listNewerMessages` either.

Severity remains "Low" — this is a real-but-tiny efficiency cleanup, and the proposed fix (an explicit `select: { id, name, avatarUrl }`) is safer than the current code only if it ALSO includes the fields `mapUser` reads — i.e. `id, teamId, role, name, email, avatarUrl, createdAt, deactivatedAt, availabilityStatus, availabilityMessage`. A naive `select: { id, name, avatarUrl }` would crash `mapUser` (returns `role`, `teamId`, `email`, `isActive` derived from `deactivatedAt`, etc.), which the finder's fix description ("Switch the three sites to an explicit select: { id, name, avatarUrl }") would actually break. Confirmed-but-revised: finding stands at Low, fix description needs to widen the select list to match `mapUser`'s read set or it will introduce a regression worse than the smell.


## L29. WorkflowsController has no class-level SessionGuard — relies on every method remembering a decorator
_REST API surface_ · `apps/api/src/team/workflows/workflows.controller.ts:42-44 (controller declaration without class-level UseGuards)`

**Problem.** Unlike every other authenticated controller in `apps/api/src/`, `WorkflowsController` has no `@UseGuards(SessionGuard)` at the class level (apps/api/src/team/workflows/workflows.controller.ts:42-44). The class comment acknowledges this is per-method by design (some routes are admin, one is any-agent), and today every method DOES have either `@RequireRole("admin")` (which composes SessionGuard via `applyDecorators`) or `@UseGuards(SessionGuard)`. But the safety property — "add a route, get auth by default" — is gone. Adding a new GET/POST and forgetting the guard mints a public endpoint.

**Why dangerous.** The convention everywhere else in this codebase is class-level SessionGuard + method-level Role/Capability tightening. WorkflowsController inverts that posture, so a future PR that adds e.g. `@Get(":id/preview")` without an explicit guard exposes workflow definitions (which contain step config + variable bindings — sometimes credentials in template params) to the public internet. NestJS does NOT warn about a controller without a class-level guard.

**Impact.** Latent risk, zero impact today. Bites the first time someone adds a workflow read endpoint without explicitly applying a guard — likely during the AI-agent or outbound-webhook workstream resumption that touches this controller.

**Fix.** Add `@UseGuards(SessionGuard)` to the class decorator block. The existing `@RequireRole("admin")` on individual methods is a no-op layered on top (RoleGuard already composes SessionGuard, but Nest dedupes). The `manualTrigger` route's explicit `@UseGuards(SessionGuard)` then becomes redundant and can be removed for symmetry.

**Verifier note.** The finding is factually accurate: I confirmed `apps/api/src/team/workflows/workflows.controller.ts:42` has `@Controller(...)` with no class-level `@UseGuards(SessionGuard)`, while every other authenticated controller in the repo (inbox, conversations, contacts, messages, broadcasts, notes, calls, users, tags, stages, snippets, audience-groups, media, channels, team-root, contact-fields, permissions, whatsapp-templates, change-password, dev-emit, inbox-search) puts SessionGuard at the class level. The only global guard via APP_GUARD is `RateLimitGuard` (CommonModule), not SessionGuard, so a method-level omission really would mint a public endpoint.

However, the severity is overstated at Medium. The "Medium" tier in the rubric is "correctness / maintainability problem, not user-visible yet." This finding has no correctness defect today — every existing method is correctly guarded (`@RequireRole("admin")` composes SessionGuard via `applyDecorators` per `role.guard.ts:32-37`; `manualTrigger` has explicit `@UseGuards(SessionGuard)`). The class doc-comment (lines 27-41) explicitly documents the per-method posture as deliberate because the route mix splits admin vs any-agent. This is a maintainability/defensive-coding smell with a latent risk that bites only on a future PR mistake — that maps to Low ("cleanup / smell, defer-friendly").

The proposed fix is sound (adding `@UseGuards(SessionGuard)` at class level is safe — running SessionGuard twice is idempotent since it just reads `req.session`), and removing the redundant `@UseGuards(SessionGuard)` on `manualTrigger` is reasonable. So the verdict is partial: real finding, real fix, but severity should be Low not Medium.


## L30. Workflow `POST /api/team/workflows` and `PATCH :id` skip Zod pipe — error envelope diverges from the rest of the API
_REST API surface_ · `apps/api/src/team/workflows/workflows.controller.ts:54-65 (create), :146-156 (update)`

**Problem.** WorkflowsController.create and update both accept `@Body() body: unknown` instead of using `@Body(zBody(...))`. The class comment explains the rationale (the workflow document is too recursive for a clean Zod schema) and delegates to `parseWorkflowBody` in `lib/workflows/parse.ts`. The byproduct is documented in the comment itself: `parseWorkflowBody`'s error shape is `{ error, details, stepErrors }`, while every other endpoint in the API returns `{ error: "invalid_body", issues: ZodIssue[] }`. The frontend has to know which envelope to parse for which endpoint.

**Why dangerous.** Frontend error handlers either (a) hardcode the workflow-specific envelope and re-implement it for every new workflow client, or (b) generic-handle the response as opaque JSON and lose actionable error details. Either way, the divergence costs every consumer of the API. Also a documentation hole — `WORKFLOW_BODY` is not OpenAPI-able without bespoke type generation.

**Impact.** Maintenance burden, not a runtime issue. Hits anyone implementing a workflow editor outside the existing React Flow canvas (e.g. CLI tooling, future per-team integrations API). Documented as intentional but flagged so the divergence is consciously paid, not absorbed silently.

**Fix.** Either (1) wrap the body in a thin Zod schema `z.object({ nodes: z.array(z.any()).min(1), edges: z.array(z.any()), trigger: z.string(), ... }).passthrough()` and let `parseWorkflowBody` continue to do the deep validation — that gets the request through the standard Zod pipe and unifies the 400 shape — or (2) wrap `parseWorkflowBody` failures in a `BadRequestException({ error: "invalid_body", issues: stepErrors.map(...) })` adapter so the response shape matches. Option (1) is cheaper and preserves the existing `lib/workflows/parse.ts` behavior.

**Verifier note.** Verified the code: workflows.controller.ts:56 (create) and :151 (update) both use `@Body() body: unknown`, and workflows.service.ts:116-120 / :209-213 / :276-280 do throw `BadRequestException({ error, details, stepErrors })`, distinct from zBody's `{ error: "invalid_body", issues }`. The factual claim is correct.

However, the finding is overstated:

1. The divergence is intentional AND documented inline (controller class doc + per-method comment explicitly call it out). The user's coding style is "surface tradeoffs, don't hide them" — this is already surfaced.

2. The proposed fix (#1) wouldn't actually unify the envelope. A passthrough Zod schema would only catch top-level shape errors; `parseWorkflowBody` would STILL throw `{ details, stepErrors }` on deep validation, so two envelopes would coexist (`{ error: "invalid_body", issues }` for shape + `{ error: "validation failed", details, stepErrors }` for deep) — strictly worse than today's single divergent envelope.

3. The proposed fix (#2) would lose information: `stepErrors` is `Record<string, string>` keyed by NODE ID, consumed by the React Flow canvas (workflow-builder.tsx:170, 217, 452 — `step-editors.tsx:156`) to highlight specific nodes red. Collapsing into `issues: ZodIssue[]` removes the structural mapping that the UI relies on; the canvas would have to reconstruct node→error mapping from a path array. That's a regression in UX clarity, not a fix.

4. Blast radius is minimal: this is `/api/team/workflows` (admin-only, internal), not the external `/v1/*` API. Exactly one consumer exists today (workflow-builder.tsx). The "future CLI tooling / per-team integrations API" cited in the impact is hypothetical and explicitly deferred in CLAUDE.md ("scoped API keys, IP allowlists, OpenAPI spec" are paused workstreams).

5. The user's memory contains a relevant prior decision pattern ("external reviews vs locked decisions" — generic-shape advice that ignores why the existing code is shaped that way is exactly this finding's class). This is documented-intentional with a single first-party consumer that handles it correctly.

Verdict: partial — the divergence is real but the severity is overstated. At most Low (cleanup/smell, defer-friendly) — and even then, the fix the finder proposes would not improve the situation without a richer envelope design.


## L31. Error response shapes are mixed — bare string vs `{ error }` object across controllers
_REST API surface_ · `apps/api/src/media/media.controller.ts:82,91,128,131 (bare string), apps/api/src/dev/dev-emit.controller.ts:117 (bare string), apps/api/src/webhooks/meta/meta.controller.ts:115,133 (bare string)`

**Problem.** The codebase mostly throws `new HttpException({ error: "…" }, status)` or `new NotFoundException({ error: "…" })`. But several controllers throw `new NotFoundException("not found")` (plain string) — see MediaController (4 sites), DevEmitController, AdminTeamsController (some sites), and the bare-string `BadRequestException("conversationId and file are required")` etc. NestJS serializes the bare string as `{ message: "…", error: "Not Found", statusCode: 404 }` and the object form as the literal body — so the client sees TWO different envelopes for the same conceptual error.

**Why dangerous.** Clients that read `body.error` to render a toast get `"Not Found"` (NestJS's default) on the bare-string sites and the project's intended message on the object sites. The error display text is inconsistent and depends on which controller threw.

**Impact.** Minor UX inconsistency. No security or correctness impact, but a small ongoing tax — every new endpoint has to guess the right shape.

**Fix.** Either standardize on `throw new XxxException({ error: "…" })` everywhere (one-line edit per call site), or install a global exception filter that normalizes both shapes to `{ error, detail, statusCode }`. The latter is the smaller surface — one file in CommonModule — and prevents future drift.

**Verifier note.** The factual claim is confirmed at the cited lines — 14 bare-string `throw new XxxException("…")` sites exist (MediaController 4x at 82/91/128/131, DevEmitController 117, Meta webhook 115/133, plus auth guards), and the majority of the codebase uses the `{ error: "…" }` object form. So the inconsistency itself is real.

However, the impact framing is overstated. The finder's failure mode — "clients reading body.error get NestJS's default 'Not Found' instead of the intended message" — is not reachable at any of the specific cited locations:

1. MediaController (4 sites): the frontend consumer in `apps/web/src/features/inbox/lib/open-attachment.ts` uses the `?probe=1` JSON path (returns 200 with `{ available: false }`) for liveness, and `window.open(url, "_blank")` for actual download — neither parses body.error. A 404 here surfaces as a browser-native page, not a toast.

2. Meta webhook (2 sites): the only "client" is Meta's webhook fetcher, which checks status code only and ignores body. Meta doesn't render toasts.

3. DevEmitController (1 site): gated behind `ENABLE_DEV_TOOLS === "1"`, not enabled in production.

4. The 5 auth-guard "forbidden"/"unauthorized" tokens are convention-consistent across the guards themselves, and frontend client code (e.g. session.guard's consumers) routes on HTTP status (401/403) not on body shape.

I checked frontend error-rendering call sites (reply-box, template-picker, forward-dialog, contact-panel, interactive-popover, message-thread/utils.ts) — they all read `body.error ?? "…"` with a fallback string, so even if they DID hit a bare-string endpoint, the fallback path would render a reasonable string ("Couldn't save", "Send failed", etc.) — not the NestJS default verbatim.

The PrismaExceptionFilter at /home/aliubuntu/projects/loadless_projects/customer-communication-platform/apps/api/src/common/prisma-exception.filter.ts already normalizes Prisma escapes to `{ error: errorKey }`, so the safety net for unexpected leaks is in place.

Net: a real-but-cosmetic maintainability smell, severity stays Low. The proposed fix (global exception filter) is reasonable but defer-friendly; it would not change any user-visible behavior today. The finder's own severity label (Low) is correct — I'm marking partial because the "why_dangerous" mechanism doesn't fire at the cited locations in current architecture.


## L32. POST create endpoints split 200 vs 201 by controller — no convention
_REST API surface_ · `apps/api/src/team/tags/tags.controller.ts:58 (POST returns 200, no HttpCode), apps/api/src/team/snippets/snippets.controller.ts:51, apps/api/src/team/audience-groups/audience-groups.controller.ts:46, apps/api/src/team/outbound-webhooks/outbound-webhooks.controller.ts:50, apps/api/src/team/api-keys/api-keys.controller.ts:33, apps/api/src/invites/invites.controller.ts:32, apps/api/src/broadcasts/broadcasts.controller.ts:43, apps/api/src/notes/notes.controller.ts:28`

**Problem.** Some POST-create routes set `@HttpCode(201)` (ContactsController, StagesController, ContactFieldsController, ChannelsController). The rest leave the NestJS default 200 (Tags, Snippets, AudienceGroups, OutboundWebhooks, ApiKeys, Invites, Broadcasts, Notes). Same HTTP method, same semantics (create resource → return resource), different status codes.

**Why dangerous.** Clients that distinguish 200/201 (HTTP-aware loggers, OpenAPI generators, retry middleware that re-runs idempotent 5xx but not 2xx) see the API as inconsistent. The 201-with-Location idiom isn't used either — no Location header is set on any 201 response — so the partial adoption isn't even buying its supposed benefit.

**Impact.** Style / API-design hygiene only. No functional impact.

**Fix.** Pick one convention. Easiest path: drop every `@HttpCode(201)` since none of these set a Location header, and 200 is fine for a JSON-body API. Alternative: add `@HttpCode(201)` to the remaining create handlers and remove the `{ ok: true }` envelope (a 201 with the resource is its own success signal).

**Verifier note.** Verified the factual claims: contacts.controller.ts:82, contact-fields.controller.ts:72, stages.controller.ts:65, and team-chat/channels.controller.ts:164 all set `@HttpCode(201)` on their POST create endpoint. The eight other POST creates cited (tags:58, snippets:51, audience-groups:45, outbound-webhooks:50, api-keys:33, invites:32, broadcasts:43, notes:28) do not set @HttpCode, so they return the NestJS default 200. Line numbers are accurate within +/- 1. No Location header is set on any of the 201 responses (verified by grep — no `setHeader.*Location` or `res.location` in any controller). The inconsistency is real but the impact is purely API-design hygiene: no client breakage, no failure mode, no security or correctness implication. The finder self-rated it Low which is correct — this is exactly the kind of "defer-friendly cleanup smell" the severity guide describes. The proposed fix (drop @HttpCode(201) everywhere since no Location header is set) is reasonable and non-destructive. Nothing in CLAUDE.md or memory marks this as intentional/locked. Finding stands as-is.


## L33. `webhook:subscription_recovered` server-side socket frame has no client consumer
_Realtime / Socket.io / bus_ · `apps/web/src/features/settings/components/outbound-webhooks-manager.tsx:127 (only subscribes to `webhook:subscription_disabled`); server emits at apps/api/src/realtime/fanout-rules.ts:514`

**Problem.** fanout-rules.ts:514 emits `webhook:subscription_recovered` to the team room when an auto-disabled outbound webhook starts succeeding again. The event is declared in packages/shared/src/socket/events.ts:449 and the domain event `WebhookSubscriptionRecoveredEvent` is published from `apps/api/src/lib/outbound-webhooks/worker.ts:404`. But nowhere in apps/web/src does any code call `socket.on("webhook:subscription_recovered", ...)` — grep confirms zero subscribers. The `outbound-webhooks-manager.tsx` settings page subscribes only to `webhook:subscription_disabled` (line 127).

**Why dangerous.** Dead frame: every recovery event is fanned to every connected tab of every agent on the team, parsed into JS objects by Socket.io, dispatched through socket.io-client's listener tree (which is empty), then GC'd. Wasted bandwidth + CPU at the server-side and at every connected browser. More importantly: the UX intent in the type doc — "The settings page clears any 'webhook unhealthy' badge so the operator doesn't need to refresh" — is silently broken. After auto-disable fires (with a toast), recovery is invisible until the operator manually reloads /settings/integrations or a follow-up event fires.

**Impact.** Low user-visible impact today (the auto-disabled webhooks are gated on N consecutive failures; recovery is the rarer case). Bites operators trying to monitor flaky partner integrations — they get the bad-news toast but never the good-news clear-up, so the badge stays "unhealthy" until reload.

**Fix.** In `outbound-webhooks-manager.tsx`, add the symmetric listener next to the disabled handler: `socket.on("webhook:subscription_recovered", onRecovered)` + matching `socket.off` in cleanup. `onRecovered` should set the row's status to `enabled: true` and clear the unhealthy badge for the matching webhookId, and optionally surface a small "recovered" toast. The fanout rule already carries the webhookId in the payload.

**Verifier note.** Verified the finding at the cited locations:

1. apps/api/src/realtime/fanout-rules.ts:514 emits "webhook:subscription_recovered" to the team room — confirmed.
2. apps/api/src/lib/outbound-webhooks/worker.ts:404 publishes the domain event after every successful delivery that follows any prior failure (priorFailures > 0) — confirmed.
3. packages/shared/src/socket/events.ts:449 declares the event with a docstring explicitly promising "The settings page clears any 'this webhook is unhealthy' badge so the operator doesn't need to refresh" — confirmed.
4. apps/web/src/features/settings/components/outbound-webhooks-manager.tsx:127 subscribes ONLY to webhook:subscription_disabled — confirmed.
5. grep across all of apps/web/src for "subscription_recovered" returns ZERO matches — confirmed dead frame.

Not listed as intentional/locked/deferred in CLAUDE.md or auto-memory.

Severity Low is appropriate: no data loss, no security, no perf cliff. Wasted frames are cheap (team-room fanout, small payload). The user-visible bug is the unhealthy badge staying stuck after recovery until manual reload — a genuine UX gap but a rare-encounter one (operator must be actively watching settings during a partner outage→recovery cycle).

Minor nuance the finder slightly miscalled (doesn't change severity): the recovery event actually fires on EVERY success after ANY prior failure (priorFailures > 0), not only after auto-disable. So the frame is more frequent than implied, but most fires don't have a badge to clear anyway. The "stuck badge after auto-disable→recovery" UX hole still applies whenever both conditions co-occur.

Fix proposed (add symmetric socket.on listener) is concrete, mirrors the existing onDisabled pattern, introduces no new failure mode, and matches the locked optimistic-socket-dispatch rule. Confidence: high.


## L34. `user:profile:updated` optimistic dispatch from the actor has no listener — silently no-op
_Realtime / Socket.io / bus_ · `Server fanout at apps/api/src/realtime/fanout-rules.ts:469-482; orphan local dispatches at apps/web/src/app/(app)/settings/account/profile-form.tsx:63,113,143`

**Problem.** Server-side `user.profile_updated` fanout in fanout-rules.ts:469 emits TWO frames: `user:profile:updated` (per-user payload) AND `team:catalog:changed` with scope `members`. The actor's local dispatch in `profile-form.tsx:63/113/143` calls `dispatchLocalSocketEvent("user:profile:updated", {...})` — but `grep -rn 'user:profile:updated'` across apps/web/src finds ZERO `socket.on("user:profile:updated")` listeners. Every cached sender-name / avatar update that the type doc promises ("Cached sender names + avatars across the inbox, assignment dropdowns, contact-panel 'assigned to' labels, and team-chat author rows update against this without a refetch") actually flows ONLY through the `team:catalog:changed` scope="members" path, which triggers a `router.refresh()` on certain routes — a full RSC reload, not a per-cell in-place patch.

**Why dangerous.** The promised behavior — instant in-place avatar/name swap across many cached client surfaces without a refetch — does not happen. Instead, the team gets a full RSC re-render of the current route (via `team:catalog:changed`), and any in-memory state (LRU cached message threads, displayed thread's embedded author names) keeps stale data until the next chat-switch or refresh. The local dispatch in profile-form looks like it should provide instant local update for the actor, but with no listener attached it does nothing — actor's own surfaces only update via the same RSC refresh path.

**Impact.** Minor: avatar/name lag for teammates after a profile change; the optimistic-dispatch infrastructure looks load-bearing but is dead code. No correctness bug, just an unfulfilled UX promise + dead code smell.

**Fix.** Either (a) implement the promised per-cell patch — add a `useUserProfileSync` hook (mounted in InboxShell / TeamChatWorkspace / sidebar) that listens to `user:profile:updated` and patches an in-memory `Map<userId, {name, avatarUrl}>` that all author-name / avatar surfaces read from; OR (b) delete the dead frame: remove the local dispatches in profile-form.tsx + the `user:profile:updated` fanout case in fanout-rules.ts + the event from socket/events.ts and types.ts. Option (b) is cheaper and matches the actual behavior (everything routes through `team:catalog:changed`).

**Verifier note.** Independently verified at the cited locations:

1. fanout-rules.ts:469-482 emits BOTH `user:profile:updated` and `team:catalog:changed` (scope=members) as claimed.
2. packages/shared/src/socket/events.ts:589 declares the event with exactly the JSDoc promise the finder quoted ("Cached sender names + avatars... update against this without a refetch").
3. Repo-wide grep for `socket.on("user:profile:updated")` / `onUserProfileUpdated` / `profile:updated` / `profile_updated` listeners across apps/web/src returns zero hits — only the 3 dispatch sites in profile-form.tsx and the type declaration. The shared events.ts declaration is the only reference; nothing subscribes.
4. The actual cached-cell update path is the `team:catalog:changed` scope=members frame, which drives RSC-refresh / catalog refetch — not per-cell in-place patches.
5. Not flagged anywhere in CLAUDE.md or auto-memory as intentional/locked/deferred.

Severity Low is appropriate: no correctness break, no security issue, no scaling cliff — just dead optimistic dispatch + unfulfilled UX promise in the event's JSDoc. Proposed fix (b) — delete the frame + local dispatches — is the cheaper, lower-risk option and aligns with how every other catalog-shaped change already routes. Fix (a) — implement a real userProfileSync map — adds value but is larger surface area.

Finding stands as written.


## L35. `team_channel.message_created` type doc references team-room emit; code emits to channel room — doc drift
_Realtime / Socket.io / bus_ · `Doc strings at packages/shared/src/events/types.ts:534-559 (and the actual code in apps/api/src/realtime/fanout-rules.ts:327-346 + realtime.gateway.ts:727-732)`

**Problem.** packages/shared/src/events/types.ts:534-543 documents the fanout shape as: "Top-level → Socket fanout emits `team:channel:message` to the TEAM ROOM with preview + lastMessageAt populated. Reply → Socket fanout emits (a) `team:channel:message` to TEAM ROOM (preview/lastMessageAt null), (b) `team:channel:thread:reply` to TEAM ROOM, (c) `team:channel:message` to the CHANNEL-THREAD ROOM". The actual code in apps/api/src/realtime/fanout-rules.ts:327-346 emits to `channelRoom(e.channelId)` for all cases — NOT the team room. The channel-thread room mentioned in the doc no longer exists (the gateway comment at realtime.gateway.ts:728 explicitly says "(No subscribe:channel-thread handler — thread replies, edits, deletes, and reactions are all delivered through the team room and filtered client-side... The thread room would be dead weight)").

**Why dangerous.** The code is correct (channel-room scoping enforces `requireChannelMembership`-gated security so non-members can't read message bodies); the DOC is stale. Future contributors reading the type doc will think team-room broadcasts are the contract and may write fanout for new related events to the team room, leaking channel content to non-members. The contradiction "channel-thread room" vs "thread room would be dead weight" between the two doc strings is a maintenance trap.

**Impact.** No runtime impact. Maintenance footgun for anyone adding a new team-channel event type.

**Fix.** Update the doc in `TeamChannelMessageCreatedEvent` to reflect the actual scoping: "All emits go to the CHANNEL room (membership-gated via subscribe:channel). Top-level → one `team:channel:message` with preview + lastMessageAt. Reply → `team:channel:message` (preview/lastMessageAt null; clients filter on threadRootId for the thread panel) + `team:channel:thread:reply` (bumps the root's reply pill)." Remove the obsolete "channel-thread room" reference. Also update `socket/events.ts` similar comments for consistency.

**Verifier note.** Verified at the cited locations. packages/shared/src/events/types.ts:534-541 explicitly documents three emits to "the team room" plus a "channel-thread room", but apps/api/src/realtime/fanout-rules.ts:327-346 calls emitter.emitToChannel(e.channelId, ...) for both the top-level and reply paths. The "channel-thread room" referenced in the doc does not exist — realtime.gateway.ts:728-732 confirms there is no subscribe:channel-thread handler. The fanout-rules.ts:319-326 header comment is the actually-current spec ("Channel events fan out to the CHANNEL room, not the team room") and directly contradicts the type-file doc, so future contributors face a real maintenance trap. The realtime.gateway.ts:728-732 comment also has the same stale "delivered through the team room" wording — drift is slightly broader than the finder noted but they correctly pinpointed the canonical source. Severity Low is right (doc-only, no runtime impact today; the security-relevant emit is correctly channel-scoped). The proposed fix (update the doc string to match the code, drop the obsolete "channel-thread room" reference) is strictly safer than the current state and introduces no regressions.


## L36. Dead `refreshing` state in useTeamEvents
_State management_ · `apps/web/src/features/team-chat/hooks/use-team-events.ts:129,272,321,982`

**Problem.** `useTeamEvents` exposes a `refreshing` boolean in its returned state (apps/web/src/features/team-chat/hooks/use-team-events.ts:982) — set true during a filter-change refetch (line 272) and cleared on finish (line 321). No consumer reads it: a grep across `apps/web/src/features/inbox/` finds zero references to `live.refreshing` or `.refreshing`.

**Why dangerous.** Not dangerous — purely dead code. But it's an extra two setState calls per filter change firing through React's reconciler for no rendered effect. Misleads readers into thinking some UI surface depends on it (e.g. a refresh spinner that isn't wired).

**Impact.** Cleanup smell. Two wasted setState commits per filter switch.

**Fix.** Either drop the `refreshing` state + the two setState calls + the field on `TeamEventsState`, OR wire it to a subtle indicator (e.g. a top-of-list shimmer in conversation-list.tsx). Dropping is the simpler call — the filter-change is already nearly invisible because the instant re-derive at line 282-284 paints correct rows before the fetch lands.

**Verifier note.** Verified directly in code. /home/aliubuntu/projects/loadless_projects/customer-communication-platform/apps/web/src/features/team-chat/hooks/use-team-events.ts confirms all four cited lines: line 129 declares `useState(false)` for `refreshing`, lines 272 and 321 are the only setRefreshing calls (set-true on filter change, set-false in fetch's finally), and line 982 exposes it on the returned object. The sole consumer is inbox-shell.tsx (line 545 binds the hook as `live`); grepping it pulls `live.conversations / hasMore / loadingMore / loadMore` but never `live.refreshing`. A broader `grep -rn "\.refreshing\b" apps/web/src` returns zero hits. So the field is genuinely dead. Severity Low is right: this is a pure cleanup smell — two wasted setState commits per filter switch, no correctness or perf cliff. The instant re-derive at lines 282-284 already paints correct rows synchronously, so dropping the `refreshing` state is the safer fix than wiring a spinner. Not flagged as intentional in CLAUDE.md or MEMORY.

