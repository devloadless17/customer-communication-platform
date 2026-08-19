# Pre-Launch A-to-Z Verification Program — Ledger (2026-08-19)

Plan: ~/.claude/plans/as-a-junior-developer-goofy-tulip.md
Baseline: branch `production` @ f15bc921, clean tree. Last full-green: 2026-08-13 (run 31674153362 deployed). Delta since: 73 files / +4327 −380 (webchat polish, contact segments).

Resume state: if a session is cut, continue from the first section below not marked DONE.

## Program state

| Stage | Status |
|---|---|
| Phase 0 baseline gates (`pnpm check`) | PASS (exit 0, 2026-08-19) |
| Phase 0 api vitest baseline | PASS — 1559/1559 |
| Phase 0 S8 dependency audit | DONE — undici HIGH fixed (commit 6b86de82); remaining: 1 high (deepmerge-ts via prisma dev-chain, not runtime), moderates in dev chains + uuid-via-exceljs (accepted, bounded exposure) |
| Direct-read list (orchestrator) | IN PROGRESS — PASSED so far: send-idempotency + send-queue + send-worker + executeTextSendJob (OutboundSendAttempt state machine sound in every crash window); broadcast-runner per-recipient CAS + attempt lifecycle; send-rate-limiter (atomic Lua, Coexistence 18<20 wins); blob-orphan (cross-check registry complete vs schema — verified no unregistered blob-key columns); resolveActiveWorkspaceId + makeCanAccessBeyondMembership (branches correct); ticketAccessWhere + call-site scan (remove-member handles guest-side shares); workflow send_message (journaled, budget-guarded) + http_request (SSRF, stable delivery key, depth); /v1 api-idempotency (ambiguity-protected claims, atomic reclaim) + /v1 sendText release-only-on-provably-not-sent; meta-waba-subscription (our-app check, truncation refusal). REMAINING: contact-transfer import path detail (U7 reviewer + spot done on artifacts sweeper), retention sweeper predicates (post-S3), meta-page-subscription self-heal (U1b + verify). |
| Wave 1 reviews + verify (U7, U10, U2a/b, U1a/b) | DONE — 53 findings, 18 confirmed |
| Wave 2 reviews + verify (U4, U3, U8, U9) | DONE — 28 findings, 10 confirmed |
| Sweeps A (S2, S3, S5, S6, S7) | DONE — 21 findings |
| Wave 1 fixes | LANDED + gates green + COMMITTED (acf77c2d, e594e559, 1fc6c86f, e9053362, eeb415d9, 0a59a8eb) |
| Wave 2 fixes (workflows/broadcasts/auth) | LANDED + gates green + COMMITTED (dc2a973c, a82bd095, fc40f675) |
| settings-secrets fix (S7-2) | LANDED + COMMITTED (9e0c0551) |
| Sweeps B (S1, S4, S10, S12, S13) | DONE — 38 findings (1 critical, 5 high) |
| S1 TENANCY RESULT | **1,778 Prisma call sites + 84 raw SQL + 312 @Param handlers audited: ZERO unscoped-and-request-reachable queries.** 309/312 handlers carry session/API-key scope; the 3 exceptions are credential-gated public surfaces (invite token, HMAC'd Meta webhook, HMAC'd workflow webhook). All raw SQL parameterized. checker allowlist matches schema exactly. Only finding: no MECHANICAL CI control exists (TEN-01, medium). |
| S12-2 critical (conversation delete cascades into tickets + shares) | FIXED + COMMITTED 4055a283 |
| Sweeps B fixes (batch 1) | COMMITTED |
| Sweeps B deferred to after Wave-3 fleet (file collisions) | S12-1 (/v1 tag delete skips view scrub, HIGH), S4-01..S4-14 (docs accuracy + parity), S12-4 (AI retention sweeper) |
| Wave 3 reviews + verify (U6, U11, U5, U12) | DONE — 44 findings, 25 CONFIRMED (1 critical, 3 high), 0 refuted |
| Wave 3 critical/high direct-reads + fixes | COMMITTED 0cc465c6 (U11-01 critical, U6-1 cross-workspace) |
| Wave 3 fixes (remaining 21) | LANDED — gates green (`pnpm check` exit 0), typecheck clean both apps |
| Wave 4 reviews (U13, U14) | DONE — 16 findings, 12 confirmed (1 critical: superAdmin password) |
| Wave 3 + Sweeps B fixes | COMMITTED (40ad061e tickets, 74b0e1dd ai, cb9fb4d8 calls/team-chat, 04fa15cf v1, 3a034b12 views/lists, d81b5d22 v1 tags) |
| Cleanup fleet (S4 docs, S12-4 AI retention, 97 lows) | DONE — committed 1ecec952 |
| E2E gate completeness | FIXED + COMMITTED a09a5efd — 3 root specs (incl. contacts-segments) were never run by the batched gate; now batched + self-checking |
| UI inventory (step 7 input) | DONE — 82 routes / 1009 elements / 74 destructive (UI-INVENTORY.md) |
| Low-findings pass (97 collected) | DONE — committed 1ecec952 |
| S11 coverage-manifest diff | DONE — 792/1103 files explicitly attested by wave reviewers; **311 never opened**. Follow-up pass reviewed all of them (337 files incl. corroboration), 253 clean, 51 findings, 15 CONFIRMED. Coverage is now provable. |
| Coverage-gap fixes | COMMITTED (b5a634ae, 4f6c7d52, 8fc1a0d9, 6f02970a) — gates green, 1560 tests |
| Live phase: batched e2e | RUN 1 DONE — **592 passed / 11 failed**. Green: batches 0,1,2,6,7. Failed: 3,4,5,8. |
| Live phase: rerun of failing batches | DONE — all 4 re-run alone on fresh stacks; see "Live-phase results" below. |
| Memory | `full-system-audit-2026-08-19.md` written + indexed |
| Live phase: meta / multiaccount / uiux | meta + multiaccount PASS; uiux running |
| Final gate chain | pending (re-run `pnpm check` + api vitest before finishing — both were green at 6f02970a) |

## Gate history
- 2026-08-19 post-Wave-1-fixes: `pnpm check` exit 0; api vitest 1559/1559; partial-index tripwire green.
- 2026-08-19 post-Wave-2-fixes + settings-secrets: `pnpm check` exit 0; api vitest 148 files / 1559 tests; migration `20260819060000_workspace_deleting_claim` applied to the dev DB.

## Live-phase results (2026-08-19)

| Suite | Result |
|---|---|
| batched e2e (9 batches) | 592 passed / 11 failed → **all 11 settled** (below) |
| `test:e2e:meta` (mock Graph, incl. @pressure) | **173 passed** |
| `test:e2e:multiaccount` | **46 passed** |
| S9 partial-index tripwire (re-run post-migrations) | pass |

### The 11 e2e failures, attributed
- **1 REAL product bug** — contacts filter menus had no height cap/scroll, so their
  lower rows were unreachable once a workspace had select fields. Fixed `ba34d63f`,
  verified 17→18 passing.
- **2 REAL test bugs** (pre-existing, broke 2026-08-17, unseen because the gate was
  not run after that date) — fixed `5181c227`. Causation proved by reverting the
  audit's own widget.js hunk and watching them fail identically.
- **8 environmental** — memory pressure; batches 3 and 4 fully green when re-run
  alone (`next-server` holds ~3 GB RSS on a 5.9 GB box).

## OPEN FINDINGS (not root-caused — do not mark this audit "clean" without them)
Both are executable reproductions in `tests/e2e/realtime-convergence.spec.ts`,
marked `test.fixme` so they stay visible rather than being deleted:
1. **A second session does not render an incoming `note:new`** while the first does.
   Reproduced with a different user (restricted → admin → assignee) and the SAME
   user in two contexts, on empty and seeded threads. The second session's socket
   is demonstrably live (an assignment pill arrived on it in the same run).
2. **A session offline when a note was added does not converge on reconnect**
   (45s, no reload). §10 promises every recovery path converges to server state.

Only NOTES are covered. **A missed MESSAGE would be materially more serious** and
needs the ingest path (HMAC webhook + connected channel) the spec avoids so it
never touches a provider. That is the highest-value next check.

## ⚠ OPERATOR ACTION REQUIRED AFTER DEPLOY
The production superAdmin password is currently the literal `loadless` (every deploy re-asserted it — fixed in 0024e964, but the fix stops FUTURE resets, it cannot change the password already in the database). **After deploying, sign in as the superAdmin and change the password**, or set `SUPERADMIN_PASSWORD` and re-seed. That account can enter every workspace on the box.

## Accepted trade-offs recorded during fix-review (do not re-flag)
- `Workspace.deletingAt` excludes a mid-delete workspace from `resolveActiveWorkspaceId`. A member whose ONLY workspace is being deleted resolves to null and is logged out. Correct: the workspace is being destroyed. The org still keeps ≥1 workspace for everyone else.
- Messenger/Instagram read `SECRET_SAVED_SENTINEL` as "not typed" rather than restoring the stored plaintext: restoring a stored Page token would re-enter the `sourceToken` derivation chain the code forbids (a Page token cannot re-derive a Page token). Byte-identical to the blank optional override their forms already send.
- `manual_trigger.allowedRoles` is not enforced for `/v1` callers: an API key is not a person and holds no workspace role; it is gated by scopes.
- Set-based drift reconcilers can transiently revert a concurrent live bump within one statement (S3-3). Inherent to the reconciler pattern the handbook mandates; self-heals on the next sweep.

## Findings

### Wave 1 (U7, U10, U2a, U2b, U1a, U1b) — 53 findings, 18 CONFIRMED / 1 REFUTED / 34 low
Reviews: 6 agents, 263 files attested, 0 FAIL attestations except U7 ×2 (both = the two HIGHs).
- U7-01 HIGH reach dropped in filter-mode bulk ops — FIXING (fleet: contacts-api)
- U7-02 HIGH legacy export lacks @DenyRestrictedViewer — FIXING (fleet)
- U7-03 MED contact-share adopt not transactional — FIXING (fleet)
- U7-04 MED audience resolver missing broadcastable filter — HELD until Wave 2 (U8 active), then fix
- U7-05 MED delete-contact dialog copy false — FIXING (fleet)
- U10-01 MED (+S3-1 HIGH) retention sweeper: no activity guard, cascade-deletes tickets — FIXED by orchestrator (activity + tickets:none guards)
- U10-02 MED (+S6-1 HIGH) no per-IP aggregate cap + suggest-mode LLM uncapped — FIXING (fleet: webchat)
- U10-03 MED visitor media metadata unvalidated — FIXING (fleet)
- U2a-01 MED jobId not tenant-namespaced — FIXED by orchestrator (msg-send-<ws>-<tempId>)
- U2a-02 MED /v1 messenger-template release predicate dead — FIXED by orchestrator (+ added missing error mapping)
- U2a-03 LOW(conf) blockedAt missing on 4 send paths — FIXING (fleet)
- U1a-01 MED coexistence echo split-tx event loss — FIXED by orchestrator (redelivery recovery via fresh lastMessageAt check)
- U1b-01 MED conversions config blind read-merge-write — FIXING (fleet: providers)
- U1b-02 MED token-dead verdict fans to siblings — FIXING (fleet)
- U2b-01 MED carousel URL buttons unencoded — FIXING (fleet: templates-api)
- U2b-02 MED auth-template TTL stale closure — FIXING (fleet: templates-web)
- U2b-03 MED carousel edit upload not template-scoped — FIXING (fleet)
- U2b-04 MED requiredCarouselCards occurrence-vs-max-index — FIXING (fleet)
- U1a-02 REFUTED (reaction toggle on redelivery)
- 34 low findings: catalogued, fix pass scheduled after waves (see journal wf_97f88535-674)

### Sweeps A (S2, S3, S5, S6, S7) — 21 findings
- S3-1 HIGH retention sweeper ticket cascade — FIXED (with U10-01)
- S7-1 HIGH rotation script misses social tokens + MetaConnection — FIXED by orchestrator (fields + 2 new passes)
- S6-1 HIGH webchat per-IP + AI generation cap — FIXING (fleet)
- S3-2 MED transfer-artifacts delete-before-rows dead safety — TODO (needs blobStorage delete result surface; fix with Wave 3)
- S5-1 MED /v1 401 envelope — HELD (api-key.guard, U4 active)
- S5-2 MED checker blind to backticks — FIXING (fleet: error-keys)
- S6-2 MED AI inbox LLM rate limits — FIXING (fleet)
- S6-3 MED /v1 unauth probe order — HELD (U4 active)
- S6-4 MED health endpoint uncached — FIXING (fleet)
- S6-5 MED broadcast create 300/min — HELD (U8 active)
- S7-2 MED settings GETs echo decrypted credentials — FIXING (fleet: settings-secrets, sentinel pattern)
- Lows: S2-1 (silent guard, HELD U9), S2-2 (stale bus comment, HELD), S5-3..7 (part FIXING), S3-3 (accepted: inherent to set-based reconcilers, self-heals), S3-4 (doc-only), S6-6 (dead 600/min decorators, HELD U11), S7-3 (docblock, HELD U4)

### Wave 2 (U4, U3, U8, U9) — 28 findings, 10 CONFIRMED / 1 REFUTED / 17 low
Reviews: 4 agents, 287 files attested. FAIL attestations: U8 ×2 (= F1/F2), U4 ×1 (= U4-1).
- U9-1 HIGH trigger-config filters never enforced at dispatch — FIXING (fleet: workflows-fixes)
- U9-2 MED live workflow autosaved incomplete — FIXING (fleet)
- U9-3 MED unknown step type 500s index — FIXING (fleet)
- U8-F1 HIGH social all-accounts fan-out dead on create — FIXING (fleet: broadcasts-fixes)
- U8-F2 HIGH named-vs-positional re-derived from regex (§18 violation) — FIXING (fleet)
- U8-F4 MED direct-vs-window attribution mislabeled — FIXING (fleet)
- U4-1 HIGH password reset doesn't kick sockets/caches — FIXING (fleet: auth-fixes)
- U4-2 MED last-workspace delete TOCTOU — FIXING (fleet)
- U4-3 MED verify resend unthrottled — FIXING (fleet)
- U3-1 MED search loadMore drops account narrow — FIXING (fleet: search-fix)
- U8-F3 REFUTED (floating promise crash claim)
- Lows U4-4/5/6, U3-2 folded into fleet; remaining lows (U9-4..8, U3-3..6, U8-F5..F8) catalogued for the low-pass (journal wf_22df3388-c7c)
- Held for U11 (Wave 3 active): S5-1, S6-3 (api-key.guard); held for U5: U7-04 (lib/queries/audience-groups)

### Baseline fixes
- S8: undici HIGH CVE — commit 6b86de82

(fix SHAs + fix-review verdicts appended when the fleet lands)

## Attestations

(per roster row: PASS/FAIL/N-A with file:line — appended per wave)
