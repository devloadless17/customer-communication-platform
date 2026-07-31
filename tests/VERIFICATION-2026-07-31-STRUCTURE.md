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
| S1 | Model spine & schema structure | tenancy exceptions vs reality; partial-index lockstep incl. the 2 NEW uncommitted migrations; cascade recount at 77 models; Json-heavy models | ☐ |
| S2 | Org / workspaces / membership / session | service-less controllers; users.service grab-bag; duplicated tx idiom; single-definition rules verified at HEAD | ☐ |
| S3 | Assignment + availability | structural claims at HEAD; round-robin shim; cache-invalidation convention; naming residue | ☐ |
| S4 | Team/Workspace naming residue | `/api/admin/teams` rename (both sides); `Team.<field>` comments; `team.*` events = contracts (list-only); AssignmentPolicy→Team promotion (recommendation only) | ☐ |
| S5 | Team chat structure | 2,083 L god-service; RealtimeGateway direct injection (the ONE EventBus bypass); "#general" ×3; postMessage dedup | ☐ |
| S6 | Realtime & client state | contact-panel fake reducer consumer → rewire + pin; convergence-policy duplication (list-only) | ☐ |
| S7 | Frontend fetching & loading perf | RSC waterfalls; getOrganizationOverview cache(); soft() consistency; force-dynamic; metadata; use-call fetch | ☐ |
| S8 | Route loading & error boundaries | loading.tsx / error.tsx program; /calls dead segment; inbox layout doc-lie | ☐ |
| S9 | Frontend sectioning | features/tickets|flags|organization creation; app/←features inversion; move-only relocations; queries.ts split | ☐ |
| S10 | Backend layering | meta.controller business-logic extraction (proven by meta e2e 170); thin services; external-v1 split (list-only) | ☐ |
| S11 | UI/UX rubric + skeleton system | SURFACES → every route (derived, not hand-named); shared skeleton primitive; axe fixes | ☐ |
| S12 | Live UX walk + close-out | per-page browser pass, batched; full gates; approval list | ☐ |

## Listed for approval (grows as domains close — nothing here is executed)

- `external/v1/external-v1.controller.ts` split by resource (192 routes / 67 imports).
- `lib/providers/meta.ts` (7,766 L) split.
- `team.*` event / `team:*` frame renames — **contract-breaking** (§9 additive-only); recommend keeping wire names, renaming only internals.
- AssignmentPolicy → first-class "Team" promotion (product decision).
- Reconnect-convergence policy dedup across the 4 large hooks.
- Internal splits of the 4 biggest client monoliths (new-broadcast-form, step-editors, reply-box, message-thread).
- `AiAssistantConfig` (7 Json cols) / `WorkflowRun` (5, incl. per-run graphSnapshot) remodelling.
- Availability columns → `WorkspaceMember` (named as the correct fix in `lib/availability/schedule.ts` itself).
