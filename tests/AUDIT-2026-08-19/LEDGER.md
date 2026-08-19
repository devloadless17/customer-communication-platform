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
| Sweeps A (S2, S3, S5, S6, S7) | RUNNING (wf_83bbd429-75b) |
| Direct-read list (orchestrator) | IN PROGRESS — PASSED so far: send-idempotency + send-queue + send-worker + executeTextSendJob (OutboundSendAttempt state machine sound in every crash window); broadcast-runner per-recipient CAS + attempt lifecycle; send-rate-limiter (atomic Lua, Coexistence 18<20 wins); blob-orphan (cross-check registry complete vs schema — verified no unregistered blob-key columns); resolveActiveWorkspaceId + makeCanAccessBeyondMembership (branches correct); ticketAccessWhere + call-site scan (remove-member handles guest-side shares); workflow send_message (journaled, budget-guarded) + http_request (SSRF, stable delivery key, depth); /v1 api-idempotency (ambiguity-protected claims, atomic reclaim) + /v1 sendText release-only-on-provably-not-sent; meta-waba-subscription (our-app check, truncation refusal). REMAINING: contact-transfer import path detail (U7 reviewer + spot done on artifacts sweeper), retention sweeper predicates (post-S3), meta-page-subscription self-heal (U1b + verify). |
| Wave 1 reviews + verify (U7, U10, U2a/b, U1a/b) | DONE — 53 findings, 18 confirmed |
| Wave 2 reviews + verify (U4, U3, U8, U9) | DONE — 28 findings, 10 confirmed |
| Sweeps A (S2, S3, S5, S6, S7) | DONE — 21 findings |
| Wave 1 fixes | LANDED + gates green + COMMITTED (acf77c2d, e594e559, 1fc6c86f, e9053362, eeb415d9, 0a59a8eb) |
| Wave 2 fixes (workflows/broadcasts/auth) | RE-RUNNING (session limit killed first attempt) |
| settings-secrets fix (S7-2) | RE-RUNNING |
| Wave 3 (U6, U11, U5, U12) | RUNNING (wf_55178551-13b) |
| Wave 4 (U13, U14) + S1/S4/S9..S13 | pending |
| Low-findings pass (62 collected) | pending — tests/AUDIT-2026-08-19/low-findings-backlog.md |
| Live phase 1–8 | pending |
| Final gate chain | pending |

## Gate history
- 2026-08-19 post-Wave-1-fixes: `pnpm check` exit 0; api vitest 1559/1559; partial-index tripwire green.

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
