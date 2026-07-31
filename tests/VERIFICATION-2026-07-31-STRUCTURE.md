# Verification Ledger — 2026-07-31 STRUCTURE program

The single authority on what this program verified, how, and when. Lens:
**system structure / performance / sectioning / UX** — deliberately NOT the
correctness lens of `tests/VERIFICATION-2026-07-29.md`, which closed all 31
correctness domains at `44d538e0` two days before this program started. This
program re-opens nothing there; it asks a different question of the same code:
is the skeleton — organization → workspaces → accounts, assignment,
availability, teams, team chat, the model spine, realtime/state, page
fetching/loading, layering and sectioning — organized, layered, fast and
world-class, and does every page give the experience the handbook demands.

Method codes (same as the predecessor): **R** = adversarial code-reading pass ·
**E** = existing tests audited · **N** = new targeted tests written. A domain is
✅ only when every checklist row maps to a green test, a fix commit, or a
written R-only reason. New pins are NEGATIVE-TESTED (break the code, watch the
pin fail) before they count.

Standing constraints honored throughout:
- **No deploy, ever.** Commits stop at the working tree / local branch.
- **Shared working tree.** ~2,175 uncommitted lines of 07-30/31 campaign-
  analytics + conformance work belong to another session. This program audits
  that code (it IS what ships next) and fixes defects in it, but never stages
  those hunks — the Phase-0 snapshot of `git status --porcelain` is the
  do-not-stage list.
- Memory-constrained box: browser suite only via `pnpm test:e2e:batched`;
  `test:e2e:meta` and `test:e2e:multiaccount` never concurrently.

---

## Phase 0 — Baseline (2026-07-31, HEAD `8b94f62e`)

| Gate | Result |
|---|---|
| `pnpm run check` | ✅ **0 errors**, 29 warnings, 8/8 checkers green |
| `pnpm test` — api vitest | ⚠️→✅ **1293/1300 with 2 failures on arrival** — both were stale specs asserting deliberately-abandoned contracts (Finding #0). Green after. |
| `pnpm test` — web vitest | ✅ 24/24 |

Uncommitted-work snapshot: 66 entries recorded (scratchpad `phase0-uncommitted.txt`);
notably `prisma/schema.prisma`, two new migrations (`20260730230000_broadcast_recipient_account`,
`20260730235500_broadcast_campaign_name`), `meta.ts`/`meta-send-error.ts`/`instagram.ts`,
broadcasts + contacts-transfer + reports surfaces, `queries.ts`, `contact-panel.tsx`.

### Finding #0 — two stale specs asserted contracts the uncommitted work deliberately abandoned

Exactly the class the predecessor's Finding #4 documented (specs frozen against
intentionally-changed behavior), caught at baseline instead of mid-program.

**(a) `account-alerts-parse.spec.ts` — "max_daily_conversations_per_business wins
regardless of event".** The uncommitted `meta.ts` extended the THROUGHPUT_UPGRADE
guard to cover BOTH tier fields, with the rationale in place: the
phone-number-quality-update reference lists the same value vocabulary for
`<MAX_DAILY_MESSAGES_LIMIT>` as for `current_limit`, so on a throughput event
neither can be trusted as the 24h messaging tier — and the failure direction of
reading one anyway is setting the portfolio's cap to UNLIMITED off a throughput
event (un-gating campaigns). The committed spec still asserted the old
"max_daily always wins" contract. **Spec corrected** into the two honest halves:
both fields ignored on THROUGHPUT_UPGRADE; max_daily still beats current_limit
on every other event (priority coverage kept, previously only implicit).

**(b) `instagram-conformance.spec.ts:911` — 2018108 as `invalid_recipient`.**
The uncommitted `meta-send-error.ts` reclassified 2018108 ("This person isn't
receiving messages from you right now") to `recipient_unavailable`, documented
in place as the verbatim parallel of 551 — a TEMPORARY block/mute state, where
`invalid_recipient` advised list-cleaning a contact who may only be unreachable
today. The spec (same session's file, one hunk behind) still expected the old
code. **Spec corrected** to `recipient_unavailable`; also fixed the one-line
doc drift inside `meta-send-error.ts` itself, where the `invalid_recipient`
comment still listed 2018108 while the classifier had moved it (the
`recipient_unavailable` comment now names it instead).

Both re-run green (78/78 across the two files). The `meta.ts` guard itself was
READ and judged correct — conservative in the dangerous direction, consistent
with the "three different Meta scopes" invariant (§18: throughput is per
NUMBER, the messaging limit per PORTFOLIO).

---

## Domain matrix (12)

**Status key.** ☐ untouched · ◐ evidence gathered, checklist not fully walked ·
✅ closed (every row mapped, commit hash recorded).

| # | Domain | Lens | Status |
|---|---|---|---|
| S1 | Model spine & schema structure | tenancy exceptions vs reality; partial-index lockstep incl. the 2 NEW uncommitted migrations; cascade recount at 77 models; Json-heavy models | ✅ **2026-07-31** — Finding #1 fixed (11 unprotected indexes); cascade + tenancy gates verified mechanically |
| S2 | Org / workspaces / membership / session | service-less controllers; users.service grab-bag; duplicated tx idiom; single-definition rules verified at HEAD | ✅ **2026-07-31** — users split done; single-definitions verified; 2 R-only acceptances recorded |
| S3 | Assignment + availability | structural claims at HEAD; round-robin shim; cache-invalidation convention; naming residue | ✅ **2026-07-31** — dead exports removed (`c0c3c703`); cache convention verified 10/10; carried LOW refuted |
| S4 | Team/Workspace naming residue | `/api/admin/teams` rename (both sides); `Team.<field>` comments; `team.*` events = contracts (list-only); AssignmentPolicy→Team promotion (recommendation only) | ✅ **2026-07-31** — route/DTO/component rename landed (`ed0c81b0`); events + identifier residue carried to approval list |
| S5 | Team chat structure | 2,083 L god-service; RealtimeGateway direct injection (the ONE EventBus bypass); "#general" ×3; postMessage dedup | ✅ **2026-07-31** — gateway bypass closed (`81f7a884`); "#general ×3" refuted; split → approval list |
| S6 | Realtime & client state | contact-panel fake reducer consumer → rewire + pin; convergence-policy duplication (list-only) | ✅ **2026-07-31** — "fake consumer" REFUTED (documented design); assert list completed + CI pin (`11f4d9f7`) |
| S7 | Frontend fetching & loading perf | RSC waterfalls; getOrganizationOverview cache(); soft() consistency; force-dynamic; metadata; use-call fetch | ☐ |
| S8 | Route loading & error boundaries | loading.tsx / error.tsx program; /calls dead segment; inbox layout doc-lie | ☐ |
| S9 | Frontend sectioning | features/tickets|flags|organization creation; app/←features inversion; move-only relocations; queries.ts split | ☐ |
| S10 | Backend layering | meta.controller business-logic extraction (proven by meta e2e 170); thin services; external-v1 split (list-only) | ✅ **2026-07-31** — extraction landed + e2e-proven (`b21b71d5`); one stale spec fixed on the way |
| S11 | UI/UX rubric + skeleton system | SURFACES → every route (derived, not hand-named); shared skeleton primitive; axe fixes | ☐ |
| S12 | Live UX walk + close-out | per-page browser pass, batched; full gates; approval list | ☐ |

## Domain sessions

### S1 — model spine & schema structure — ✅ CLOSED (2026-07-31)

**Method: R (mechanical, scripted) + E (partial-indexes spec) + N (11 new tripwire entries).**

- **Cascade recount — ✅ MACHINE-CHECKED at 77 models** (was 73 at the
  predecessor's count): 60 `workspaceId + onDelete: Cascade` from Workspace,
  2 carrying `workspaceId` but cascading via a parent that itself cascades
  (`ApiIdempotencyKey` → WorkspaceApiKey, `AssignmentPolicyMember` →
  AssignmentPolicy — both parents verified `onDelete: Cascade`), 14 without
  `workspaceId`, plus `Workspace`. 60+2+14+1 = 77; nothing orphaned.
- **Tenancy gate — ✅ EXACT.** `TENANTLESS_ALLOWLIST` in
  `scripts/check-prisma-fields.mjs` is precisely the 14 no-workspaceId models,
  and the gate also fails a model that GAINS workspaceId while allowlisted
  (both directions guarded). One consistency gap fixed: `LoginAttempt` was the
  only allowlisted model without the `TENANCY EXCEPTION` schema note the
  convention (and the gate's own docblock) requires — note added (pre-auth by
  nature, keyed by email, no tenant exists yet).
- **The two NEW uncommitted migrations — ✅ verified.**
  `20260730230000` adds a nullable, deliberately-FK-less scalar stamp
  (documented in place); `20260730235500` adds `Broadcast.campaignName` plus a
  NEW raw partial index `Broadcast_campaign_rollup_idx` — correctly placed in
  its own migration per the rule written INTO the 0_init section (post-baseline
  partial indexes must not go in the baseline section: the `*_event_key_uniq`
  incident), and the pending session had already added it to the tripwire spec.
  Discipline held without intervention. The pending `schema.prisma` diff drops
  no columns, so no existing raw index is endangered.
- **Finding #1 — FIXED: the tripwire had drifted from the section it guards by
  ELEVEN indexes.** Mechanically extracting every Prisma-inexpressible index
  (WHERE / expression / opclass) from all migrations and diffing against
  `REQUIRED_PARTIAL_INDEXES`: 37 exist, 26 were pinned. The 11 unpinned —
  `AiContextChunk_content_fts_idx`, `Contact_phoneNumber_trgm_idx`,
  `Contact_workspaceId_marketingCapReachedAt_idx`, `Message_broadcastId_idx`,
  `Message_conversationId_timestamp_inbound_idx` (the 24h-window check),
  `Message_inbound_media_pending_idx`, `OutboundEvent_retention_idx`,
  `OutboundWebhookDelivery_orphan_pending_idx`,
  `TeamChannelMessage_channel_toplevel_keyset_idx`,
  `WorkflowRun_active_startedAt_idx`, `WorkflowRun_terminal_startedAt_idx` —
  are all non-UNIQUE performance indexes, so losing one to a baseline regen is
  a **silent seq-scan regression** on a hot path (media sweeper, outbox reaper,
  team-chat keyset paging, the 24h-window read), which is precisely the failure
  class this program's lens exists for. All 11 added with `protects` rationale;
  the FTS index needed a new optional `signature` field because its
  inexpressibility is the expression, not a WHERE (the loop asserted WHERE on
  every entry). **NEGATIVE-TESTED**: misspelling one name fails the spec naming
  exactly that index; restored green (2/2).
  Note the two false alarms the mechanical scan itself produced, recorded so
  they are not re-chased: `Contact_name_trgm_idx` & friends in the GENERATED
  section are Prisma-EXPRESSIBLE (`type: Gin` + `ops:` exists in the DSL — 5 in
  schema.prisma) and need no pin; and a naive `'gin' in name` heuristic flags
  `Lo·gin·Attempt` and `rin·gin·gAt`.
- **Json-heavy models** (`AiAssistantConfig` 7 cols, `WorkflowRun` 5 incl.
  per-run `graphSnapshot`) → carried to the approval list, per plan.

### S2 — org / workspaces / membership / session — ✅ CLOSED (2026-07-31)

**Method: R (adversarial + mechanical grep) + E (availability 9, full api vitest) + refactor.**

- **Single-definition rules — ✅ VERIFIED at HEAD by exhaustive grep**, not
  trusted from the exploration: `resolveActiveWorkspaceId` has exactly the
  three §18 callers (session.guard.ts:509, socket-auth.service.ts:263, web
  current-user.ts:150); `provisionWorkspace` exactly three
  (provision-organization, oauth-provision, WorkspacesService.create);
  `detachMemberFromWorkspace` exactly two (workspaces.service,
  users.service via detachFromAllWorkspaces).
- **users.service.ts grab-bag — FIXED (`7479c0d1`).** The availability +
  working-hours half (updateMyAvailability / setUserAvailability /
  writeAvailability / getUserWorkHours / setUserWorkHours / resyncAvailability)
  moved VERBATIM to a new `UserAvailabilityService` — orchestration moved,
  invariants didn't (`applyAvailability` in lib stays the one writer). Six
  wiring sites updated (users controller+module, workspace-root controller,
  /v1 service+module comment, one gateway comment). UsersService is now
  profile/roster/lifecycle at ~930 lines. Proven by api typecheck + the
  availability unit specs (9/9) + full api vitest.
- **R-only ACCEPTED — the "duplicated tx-or-client idiom" is not duplication.**
  `applyWrite` (workspaces.service:345) and `applyWrites` (users.service) share
  only the closure SHAPE (`Prisma.TransactionClient | DbService`); their bodies
  are different writes with different atomicity reasons. A shared helper would
  abstract a type union, which §17 forbids as speculative.
- **R-only ACCEPTED — the five service-less controllers stay service-less.**
  admin-workspaces / admin-organizations / register / oauth-provision /
  change-password hold ~16 small Prisma calls in 5–15-line handlers whose
  guards are load-bearing and documented in place (e.g. the
  `organization.isPlatform: false` tenancy guard, the self-team-guard history
  in the admin controller's header). Their READS already live in the domain
  layer (`lib/queries/super-admin.ts`). Extracting the writes into services
  would add a layer that reduces nothing — §17's judgment overrides §4's
  letter here. Revisit if any of these surfaces grows real orchestration.
- **Flake observed, not chased:** `test/bsuid-fork-reconcile.spec.ts` (an
  UNTRACKED spec belonging to the pending 07-31 session) failed once under
  full-suite load ("resolves by phone…" at 4.9 s) and passes 6/6 alone —
  contention-sensitive, same class as the historical sweeper flakes. Left for
  its owning session; recorded so it isn't rediscovered as new.

### S4 — Team/Workspace naming residue — ✅ CLOSED (2026-07-31)

**Method: R (exhaustive grep) + refactor (`ed0c81b0`) + E (deferred e2e).**

- **`/api/admin/teams` → `/api/admin/workspaces`** — route, controller file +
  class, response key (`{teams}` → `{workspaces}`), error key
  (`team_not_found` → `workspace_not_found`), the lib query fns
  (`listAllWorkspacesForSuperAdmin`, `getWorkspaceDetailForSuperAdmin`), the
  shared DTOs (`SuperAdminWorkspaceRow` / `SuperAdminWorkspaceDetail`, field
  `team` → `workspace`) and every consumer: web queries + both platform pages
  + limit-control + two e2e specs. All consumers are in-repo, so the break is
  clean. The three platform components that said "team" while acting on
  ORGANIZATIONS became `OrgStatusBadge` / `OrgStatusControls` /
  `DeleteOrganizationButton` (delete-org-button vs delete-team-button were
  NOT duplicates — deliberately different copy, both act on orgs; the
  misnamed one renamed).
- **Four stale comments fixed on the way**, two of them substantive: the
  users-controller and reset-password-dialog docblocks both cited a
  cross-tenant superAdmin reset route that was deliberately REMOVED
  (auth-recovery.spec.ts asserts it stays gone — its URL updated to the new
  prefix so the assertion keeps meaning); workspace-root.service cited
  `DELETE /api/admin/teams/:id`, a route that never existed under that prefix
  (the real one is `DELETE /api/admin/organizations/:id`).
- **Deliberately NOT renamed (carried to approval list):** `team.*` event
  names + `team:*` socket frames (§9: an event name is a contract, additive
  only), `TeamChannel*` models (legitimately team-chat), the
  `agentConversationVisibility: "team"` enum VALUE (a wire contract), the
  ~2,300 remaining lower-case identifier occurrences (`teamSchedule`,
  `teamSlots`, `teamCounts`…) — mechanical but wide; and the underlying
  product question, promoting `AssignmentPolicy` to a first-class "Team".
- **E note:** the two touched e2e specs (org-member-limit, auth-recovery)
  compile but the web dev server was down; they run in the close-out gate.

### S3 — assignment + availability — ✅ CLOSED (2026-07-31)

**Method: R (adversarial + scripted) + E (21 unit tests) + refactor (`c0c3c703`).**

- **Pure/IO split — ✅ VERIFIED at HEAD**: `select.ts` and `rules.ts` import
  only types (`@prisma/client` types + shared); no DB surface reaches the
  decision layer. select.ts's own comment explains why the enum parity assert
  exists (web must not import @prisma/client).
- **"EVERY WRITE INVALIDATES THE CACHE" — ✅ VERIFIED MECHANICALLY**: scripted
  scan of `AssignmentService` found 10 mutating methods, 10/10 call
  `invalidateAssignmentCache`. Membership paths: `remove-member.ts:289` and
  `users.service` (hard delete) also invalidate.
- **Carried LOW "assignment-config cache not busted on member add/re-role" —
  REFUTED at HEAD by reading both member paths**: the 15s config cache holds
  ONLY policies/rules/settings; both the live pick (`loadMembers`,
  resolve.ts) and the campaign pool (`buildPolicyPool`, pool.ts) read users +
  policy-member overrides FRESH per call. A member add/re-role is reflected on
  the very next pick with zero staleness — there is nothing for the cache to
  go stale ON. Struck from the backlog.
- **round-robin.ts shim — dead half REMOVED**: `pickRoundRobinAssignee` and
  `RoundRobinDb` had zero callers (the docblock's "real callers" claim was
  stale). `chooseRoundRobin` STAYS deliberately — its pure spec
  (tests/e2e/workflows-events/round-robin.spec.ts) is the proof that the
  engine's `least_busy` reproduces the legacy algorithm; docblock now says
  exactly that. A stale comment in resolve.ts referencing the deleted fn
  updated to point at the pin instead.
- **Naming residue**: `teamSchedule`/`teamScheduleOf` →
  `workspaceSchedule`/`workspaceScheduleOf` across the 4 availability files;
  the `teamWorkHours` RESPONSE KEY kept verbatim (wire contract, /v1-exposed).
  `availability-scope.spec.ts` updated with the rename; 21/21 green +
  `typecheck:tests` clean.
- **R-only note**: `lib/availability` remains the reference structure (2
  files, one writer, every caller through it — confirmed post-split). The
  process-local mutable state in resolve.ts (reservations, pick lock, config
  cache) is exactly as its scaling-cliff docs describe; nothing drifted.

### S5 — team chat structure — ✅ CLOSED (2026-07-31)

**Method: R (adversarial) + refactor (`81f7a884`); E deferred to the close-out
team-chat e2e batch (70 tests) — no unit specs exist for this domain.**

- **The one EventBus bypass — FIXED.** `ChannelsService` was the only service
  in the codebase injecting `RealtimeGateway` directly, and reading it showed
  the whole dependency existed for ONE call: `evictUserFromChannelRoom` on
  member removal (revoking a kicked member's live room membership). That is
  room-membership control, not emission — but it belongs WITH the frame that
  announces the removal, so it moved into the `team_channel.members_changed`
  fanout rule via a new emitter method that iterates the room and matches
  `socket.data` (the exact style of `evictStaleFromConversationRoom`, the
  precedent the conversation-assigned rule already set). The gateway's
  presence-based copy had no other caller and was deleted; its one comment
  reference now points at the emitter. Ordering preserved (frames, then
  eviction). ChannelsService now depends on `DbService + EventBus` only —
  the bus→fanout seam has zero bypasses again.
- **"#general defined in 3 places" — REFUTED by reading.** There is ONE
  definition (`lib/team-chat/queries.getDefaultChannel`, whose
  membership-filtered fallback comment documents a real leak class), one pure
  delegation (`ChannelsService.getDefault`), and one deliberately TX-SCOPED
  occurrence of the `isDefault: true` predicate in `joinDefaultChannel` —
  which must run on the caller's transaction client and therefore cannot call
  the query helper. Extracting a shared one-line where-object would be §17
  over-abstraction. No change.
- **postMessage hot path** (2-sequential-DB-call shape + `dedupCommittedSend`
  re-publish) — read and left exactly alone, per plan: it is correct, hot,
  and its header documents why it is hand-tuned.
- **The 2,083-line service split — MOVED to the approval list, with reasons.**
  Unlike users.service (four unrelated concerns), every method here is ONE
  domain's operations sharing the same guards (`requireChannelInTeam`,
  `assertNotDm`) and the same models. A split by sub-entity (lifecycle+
  membership / messages / pins+reactions) is mechanical but adds two DI seams
  without removing any coupling, and its only behavior-proof (the 70-test
  e2e batch) can't run until close-out on this box. Proposed cut lines are
  recorded below so approval is a decision, not a design session.

### S10 — backend layering — ✅ CLOSED (2026-07-31)

**Method: R + refactor (`b21b71d5`) + E (hermetic meta e2e).**

- **The Meta webhook controller extraction — DONE.** The one real
  business-logic-in-a-controller violation: 1,684 lines, 8 private
  ingestion/media methods, 8 direct Prisma calls, its own lifecycle hook.
  Everything after "the payload is trusted" moved VERBATIM to
  `MetaWebhookIngestService` (same folder): ingestWhatsappPayload +
  ingestGroup, ingestSocialPayload, completePendingMedia, hadMedia, both
  media downloaders, the retry helper, the DownloadOutcome type, the
  in-flight-media set + shutdown drain. The controller keeps exactly the
  authentication half — routes, HMAC (both per-tenant and platform secrets),
  verify handshakes, the per-workspace rate bucket, and `receiveSocial`
  (which is auth: it verifies the social HMAC before delegating). 539 lines.
- **Proof:** `pnpm test:e2e:meta` — 165 passed; the 2 failures were both
  NOT the extraction: (a) `receive-enhancements.spec.ts` asserted Messenger's
  `ad_id` in `clickId`, the exact channel-shaped contract the pending
  attribution work deliberately replaced with the unified `adId` field (the
  type's own docblock records the reasoning) — spec corrected, passes; (b)
  `@pressure` failed under full-suite load and passes clean in isolation
  (57.5s, converges in 3 redelivery passes) — its documented
  contention-sensitivity, not a regression.
- **R-only ACCEPTED (recorded in S2):** the five small service-less
  controllers stay as they are.
- `external-v1.controller.ts` split and `lib/providers/meta.ts` split stay on
  the approval list.

### S6 — realtime & client state — ✅ CLOSED (2026-07-31)

**Method: R (adversarial — and the finding REVERSED on reading) + N (CI pin,
negative-tested) + E (web vitest 37/37).**

- **"contact-panel is a fake reducer consumer" — REFUTED.** The exploration
  read the panel's direct socket subscriptions as re-implementations of
  `applyMessageFlag`/`applyNoteDeleted`/`applyContactUpdate`. Reading both
  sides shows otherwise: the panel renders from the inbox-shell's
  cacheTick-SILENT LRU snapshot, so it derives scalar mirrors (counts, note
  gallery) directly from covered events — and the thread-reducers header
  documents this design explicitly, including a warning NOT to "fix" it by
  routing through `thread.data` (that re-renders the whole shell per inbound
  message). The contact:updated block is not a reducer copy at all — it is
  the form-edit CONFLICT machine (dirty-check, park + banner, echo
  detection). The handlers that do overlap with reducers are thin payload
  projections of server-computed fields (`payload.openFlagCount`), not
  divergent logic.
- **What WAS real, and is fixed (`11f4d9f7`):** the panel's
  `assertReducerCoverage` call named 3 of the 5 events it binds — the
  contact-edit pair was bound but undeclared, so the dev invariant could not
  vouch for them. List completed; a new CI pin
  (`apps/web/test/contact-panel-coverage.spec.ts`) enforces the lockstep the
  dev assert can't (that the declared list names every `socket.on` in the
  component), with an anti-vacuity floor on both scraped sets.
  NEGATIVE-TESTED: removing one declared event fails exactly the lockstep
  case with the intended message.
- **CLAUDE.md §10 rewritten** to describe the real shape (two table-driven
  consumers + the deliberate direct subscriber) — the old "wire into all
  three" phrasing is what primed this very audit to mislabel the design;
  fixing the doc is the durable half of the fix.
- **Convergence-policy duplication across the 4 realtime hooks** (inbox
  1,974 L, team-events 1,673, team-channel 816, thread 392) — confirmed
  real, carried on the approval list (high-risk extraction; each hook's
  policy is subtly load-bearing and heavily reasoned in place).

## Listed for approval (grows as domains close — nothing here is executed)

- `external/v1/external-v1.controller.ts` split by resource (192 routes / 67 imports).
- `team-chat/channels.service.ts` (2,083 L / 1,466 code) split into lifecycle+membership+DMs / messages (post/edit/delete/threads, incl. the hand-tuned postMessage) / pins+reactions+read-receipts — mechanical, controller injects three; run the 70-test team-chat e2e batch as proof. Recommended, deferred only because the proof can't run mid-program on this box.
- `lib/providers/meta.ts` (7,766 L) split.
- `team.*` event / `team:*` frame renames — **contract-breaking** (§9 additive-only); recommend keeping wire names, renaming only internals.
- The ~2,300 lower-case `team*` identifier occurrences across api+web (`teamSchedule`, `teamSlots`, `teamCounts`, `teamActivity`…) — mechanical rename sweep, wide blast radius; recommend doing it per-file as those files are next touched rather than in one churn commit.
- AssignmentPolicy → first-class "Team" promotion (product decision — it already carries a durable member set, weights, capacity, rules and a rotation cursor; naming cleanup direction depends on this call).
- Reconnect-convergence policy dedup across the 4 large hooks.
- Internal splits of the 4 biggest client monoliths (new-broadcast-form, step-editors, reply-box, message-thread).
- `AiAssistantConfig` (7 Json cols) / `WorkflowRun` (5, incl. per-run graphSnapshot) remodelling.
- Availability columns → `WorkspaceMember` (named as the correct fix in `lib/availability/schedule.ts` itself).
