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
| event bus / outbox | 1 | | ☐ |
| workflows (~22 step types) | 1 | | ☐ |
| assignment (policies/rules/capacity) | 1 | | ☐ |
| broadcasts (+audience/templates/analytics) | 1 | | ☐ |
| tickets (+SLA+numbering) | 1 | | ☐ |
| realtime layer | 1 | | ☐ |
| auth / org / workspaces / members | 1 | | ☐ |
| external /v1 API | 1 | | ☐ |
| contacts (+import/export/transfer) | 2 | | ☐ |
| customers / identity | 2 | | ☐ |
| inbox-views | 2 | | ☐ |
| channels / multi-account | 2 | | ☐ |
| outbound-webhooks (delivery/retry) | 2 | mandatory-N | ☐ |
| calls (WhatsApp calling) | 2 | | ☐ |
| media / R2 | 2 | | ☐ |
| queues / workers | 2 | | ☐ |
| sweepers | 2 | mandatory-N | ☐ |
| coexistence | 2 | mandatory-N | ☐ |
| tags / stages / fields / snippets / flags | 3 | | ☐ |
| notes | 3 | mandatory-N | ☐ |
| team-chat (+DMs) | 3 | | ☐ |
| ai-assistant | 3 | | ☐ |
| admin / platform (superadmin) | 3 | | ☐ |
| registration / invites | 3 | mandatory-N | ☐ |
| common guards / pipes / filters | 3 | mandatory-N | ☐ |
| api-keys lifecycle | 3 | mandatory-N | ☐ |

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

## Cross-domain seam traces (after both endpoint domains ✅)

| Seam | Status |
|---|---|
| Member removal → assignments, tickets, views, policies, team-chat DMs, awaiting-reply, socket rooms, session pointer | ☐ |
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
