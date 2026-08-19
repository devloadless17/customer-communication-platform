# Pre-Launch A-to-Z Audit — Final Report (2026-08-19)

Scope: every domain, every cross-cutting dimension, every source file.
Method: 14 domain units + 13 cross-cutting sweeps + a coverage-gap pass. ~130 agents.
Every medium-or-higher finding was adversarially verified before any fix was written;
findings on irreversible paths (billing, deletion, cross-tenant) were additionally read
line-by-line by the orchestrator rather than trusted to a verifier majority.

Baseline: `production` @ f15bc921. Result: 29 local commits. Nothing pushed.

## The two apparatus failures — read these first

The audit found two defects in the **verification machinery itself**. They matter more than
any single product bug, because they mean earlier green results were not what they appeared.

1. **The e2e gate skipped three specs.** `scripts/e2e-batched.mjs` is the documented
   full-suite gate on this box (the machine OOMs on a single-pass run). Its batch list is
   hand-written, and `contacts-segments.spec.ts` — the e2e for the newest feature —
   plus `contact-select-fields` and `reports-team` had fallen off it. The gate reported
   green without executing them. Fixed, and it now refuses to start if any root spec is
   unbatched. **Any prior claim of a clean end-to-end run excluded these three.**
2. **The audit itself skipped 28% of the files.** Wave reviewers explicitly attested 792 of
   1103 source files. The coverage-manifest diff (S11) caught the other 311 — including
   `lib/crypto/envelope.ts`, `lib/http/safe-fetch.ts`, the transactional outbox, `main.ts`,
   and eight sweepers that delete rows. All 311 were then reviewed; 253 were clean and 51
   findings came out of the rest.

## Highest-severity product findings (all fixed)

| Finding | Why it mattered |
|---|---|
| superAdmin password reset on **every deploy** to a literal committed in the repo | The account can enter any workspace on the box, so every tenant's data sat behind a public string. **Requires a manual password change — see below.** |
| `/v1` idempotency released its claim after a billed send | A post-send failure let a partner's same-key retry bill the customer twice. Five routes. |
| Conversation delete cascaded into tickets and their cross-workspace shares | Tidying a thread destroyed a sibling department's live work, its history and the customer's evidence files. |
| Webchat retention sweeper cascaded the same way | Same class, reached by a scheduled job rather than a user action. |
| Workspace/org delete never released Meta webhook subscriptions | A churned customer's message content kept arriving at our ingest indefinitely. |
| Org-delete dialog confirmed the **workspace** name, then deleted the **organization** | Type-to-confirm friction is worthless when it confirms the wrong noun. |
| Guest ticket responses carried the owner's `conversationId`/`contactId` | The two fields §2 keeps private across the escalation seam. |
| Overnight opening hours were unsatisfiable | A business open 18:00–02:00 read as closed at every instant; hybrid AI auto-sent all evening instead of drafting. |
| In-app call recording accepted any callId, any state, any agent | Arbitrary audio could be attached to any call and transcribed onto the thread. |
| Tickets and Flagged had no mobile navigation entry | Both sections were unreachable on a phone. |

## What was confirmed sound

- **Tenancy.** 1,778 Prisma call sites, 84 raw-SQL sites and all 312 `@Param` handlers audited:
  **zero** unscoped-and-request-reachable queries. All raw SQL parameterized. The three
  unscoped public handlers are each credential-gated (invite token, HMAC'd Meta webhook,
  HMAC'd workflow webhook). Remaining gap: no *mechanical* CI control enforces this (TEN-01).
- **The send pipeline's double-send guards.** The three-layer idempotency (in-process lock →
  BullMQ jobId → `OutboundSendAttempt` ledger) is sound in every crash window I traced.
- **Event contracts.** All 60 domain events matrixed: publisher → tier → subscribers → socket
  frame → reducer → public webhook. No recursive chains; `broadcast.*` correctly has no audit
  or workflow subscriber.

## Operator action required

The production superAdmin password is currently the literal `loadless`. The fix stops future
deploys from re-asserting it but **cannot change the value already in the database**. After
deploying: sign in as the superAdmin and change it, or set `SUPERADMIN_PASSWORD` and re-seed.

## Verification status

See `LEDGER.md` for per-finding detail, accepted trade-offs, and gate history.
