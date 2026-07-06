# Whole-App Perfection Audit — Orchestration Prompt

> **How to use:** paste everything below the line into a fresh Claude Code session at the repo
> root (include the word **ultracode** at the top of your message to authorize multi-agent
> workflows). Nothing above the line is part of the prompt. Re-runnable: each run should
> converge — a clean run ends with "no confirmed findings" and green gates.

---

ultracode

You are the lead orchestrator for a full production-grade quality pass on this repository —
a WhatsApp multi-agent shared inbox (Next.js web + NestJS api + Postgres/Prisma + Redis/BullMQ
+ Socket.io, single VPS, docker compose). Your mission: make the whole app **correct, solid,
clean, fast, light, and simple** — world-class, with every part verified to work together.
Spawn as many agents as needed; token cost is not a constraint. Do not stop at "found issues" —
find, adversarially verify, fix, and re-verify until the app is dry of confirmed defects.

Read `CLAUDE.md` in full before anything else. It is law. Everything below assumes it.

## 0. Non-negotiable ground rules

These override any instinct you have:

1. **Locked architecture — do not re-litigate or "improve":** Socket.io lives in NestJS;
   Better Auth stays in Next.js; framework-agnostic `lib/` modules wrapped as Nest providers;
   Zod pipes (no class-validator); Prisma (no raw-SQL schema work); plain React state +
   pure reducers (no Zustand, no React Query); Meta Cloud API only (no Baileys/Evolution);
   no `Person`/`Customer` super-entity; `channel` is the discriminator, never a stored
   "provider"; two processes, one VPS, no microservices. Do not suggest Pusher, Ably,
   Supabase, tRPC, GraphQL, or rewrites of any kind.
2. **Do not re-raise refuted findings.** Known-refuted (with proof in past audits):
   duplicate-Meta-send via tx-poisoning (send path is idempotent via
   `OutboundSendAttempt @unique(jobId)`); session 401→forced-logout (client re-verifies);
   broadcast refill and `message.sent` no-retry (documented idempotent-safe). If a reviewer
   surfaces one of these, the verifier must check it against the documented refutation first.
3. **Do not re-report accepted/deferred items as bugs.** The accepted list (see CLAUDE.md
   "Skip until forced to revisit" + memory of past audits) includes: filter-bulk 50k perf
   ceiling, whatsapp-phone TOCTOU (needs functional-unique migration), single shared blob
   token, no encryption-at-rest for message bodies, in-memory rate limiting, 30s Socket.io
   recovery window, per-contact `contact.deleted` events on bulk delete, grow-only config
   cache. Mention them once in the final report's "known accepted" section if relevant;
   never spend fix effort on them without asking.
4. **Do not re-add deliberately rejected UI patterns:** spinning avatars, pending-pulse,
   unread-cue removal, button `:not([width])`, node-ring offset (see ui-elevation notes).
5. **"Behaviors that look fixable but are correct as-is"** in CLAUDE.md are correct as-is.
6. **Scope discipline:** no new features, no new channels, no new dependencies unless a fix
   is impossible without one (then ask). This is a hardening pass, not an expansion.
7. **This box may run concurrent Claude sessions on one shared working tree.** Before any
   commit: check `git status` for hunks that aren't yours and stage only your own changes.
   **Never** `git checkout -- .`, `git reset --hard`, or commit blind. **Do not push to
   main / trigger a deploy** — the deploy is user-gated. End with a clean, verified working
   tree and a report; committing is allowed only for your own hunks, pushing is not.

## 1. Phase 0 — Baseline (do this yourself, inline)

Establish the ground truth before spawning anything:

- `git status` + `git log --oneline -10` — record the starting tree state.
- `pnpm typecheck` (repo is **pnpm-only**, corepack-pinned — never npm/yarn).
- `pnpm lint` (or confirm the typecheck turbo task covers it).
- `pnpm exec prisma validate` from the repo root (Prisma 7 config loads `.env` from cwd).
- Note whether :3000/:4000 are free (WSL2 mirrors Windows localhost — :3000 may be held by
  an invisible Windows-side server; if so, plan e2e on an alternate port per
  `docs/local-setup.md` and the e2e notes below).

If baseline gates are already red, fix them first — everything downstream assumes green.

## 2. Phase 1 — Map (parallel readers)

Fan out read-only mapper agents so later reviewers get a current, correct picture (past
audit notes are point-in-time; verify against code). One mapper per cluster:

- **Backend modules** (`apps/api/src/`): admin, auth/guards, broadcasts, calls, common
  (pipes, guards, rate-limit, correlation), contacts, conversations, db, dev, events (bus,
  outbox, drainer, subscribers), external `/v1`, health, invites, media, messages, notes,
  outbound-webhooks, realtime (gateway, ws-adapter, fanout), registration, team, team-chat,
  users, webhooks (Meta ingest), workflows.
- **Framework-agnostic lib** (`lib/`): messaging, conversations, contacts, workflows engine,
  providers, events/bus, broadcast-runner, sweepers, inbox/events, crypto, safe-fetch.
- **Frontend features** (`apps/web/src/features/`): inbox (thread-reducers,
  use-conversation-events, inbox-shell, reply box, attachments), contacts (browser, panel,
  import, bulk), broadcasts, calls, workflows (React Flow builder, step editors), team-chat
  (channels, threads, scroll, reactions, read receipts), templates, tags, audience-groups,
  settings, docs; plus shared: time rendering (`useTzNow`), socket client, auth pages.
- **Data layer**: full `prisma/schema.prisma` — every model, unique constraint, index,
  enum; pending migrations.
- **Infra**: `docker-compose*.yml`, Dockerfiles (heap caps vs mem_limits), `deploy/`
  (Caddyfile.template, deploy workflow), `main.ts` shutdown chain, env validation,
  `playwright.config.ts` + `tests/`.

Each mapper returns: responsibilities, entry points, invariants it noticed, cross-module
contracts (events published/consumed, socket frames emitted/handled), and anything that
smelled off. Synthesize into a system map you keep in context.

## 3. Phase 2 — Domain × dimension review fan-out

Spawn one reviewer per (domain, dimension) cell that plausibly applies — expect 40–80
reviewers. Dimensions, with what "perfect" means for each:

- **Correctness** — logic bugs, race conditions, unhandled rejections, wrong CAS/upsert
  semantics, off-by-one, TZ/locale, nullability. Special attention to: webhook dedupe
  (`teamId+provider+externalId` compound unique, upsert-not-create), 24h-window gating,
  idempotency on every send path (messages, team-chat, broadcasts, workflow actions),
  the workflow engine's double-exec guards, BullMQ lock/graceful-shutdown interplay.
- **Realtime convergence** — every socket event that mutates per-thread state must be wired
  in BOTH `thread-reducers.ts` consumers (`useConversationEvents` AND `inbox-shell.tsx`);
  every recovery path (live socket, `?after=` delta backfill, full refetch on reconnect)
  must converge to server state; unread rules per CLAUDE.md "Read-state + reconnect
  convergence" (markRead only when visible+viewing; local `conversation:read` dispatch
  drives the list badge). Check every event in the reducer table, not just recent ones.
- **Performance** — N+1 Prisma queries, missing indexes for actual query shapes, unbounded
  `findMany`, per-item awaits that should batch, socket fanout volume (bulk paths must
  coalesce), oversized payloads over the wire, React re-render storms (context splitting,
  memo on hot lists, virtualization correctness), Next.js bundle weight (client components
  that should be RSC, heavy deps in client bundles), image/media handling.
- **Security** — authz on every controller (teamId never from client), API-key scoping,
  HMAC verification paths, SSRF safe-fetch coverage on every outbound fetch site, secrets
  handling (envelope crypto usage), rate-limit coverage, CSRF posture (sameSite:lax is the
  control — don't "fix" it), injection (Prisma protects SQL; check raw fragments, CSV
  formula-defuse is export-only), XSS in rendered message/note/chat bodies.
- **Resource safety** — memory growth (listeners, Maps, intervals, AbortControllers),
  stream/file-handle cleanup, sweeper self-disable behavior, heap-vs-mem_limit rule
  (`--max-old-space-size` ≤ ~75% of compose mem_limit), timer leaks on unmount.
- **Simplicity / cleanliness** — dead code, duplicated logic that should share a helper,
  needless abstraction, files that drifted from repo idiom, stale TODOs past deadlines
  (e.g. the legacy Meta webhook proxy has a **2026-06-19 deletion deadline** — check Caddy
  logs guidance in its header and flag), inconsistent naming, orphaned exports.
- **UX / product correctness** — optimistic-update reconcile (pending→sent→failed with
  retry reusing `clientTempId`), error surfaces (no silent failures), loading/skeleton
  states (no hydration-gated blank paints — `useTzNow` rule generalizes), empty states,
  a11y basics on interactive elements, mobile/narrow layout of the inbox.
- **Integration seams** — the cells most audits miss: Next↔Nest cookie-guard handshake,
  Caddy route table vs actual mounted routes (change-password ordering!), event bus →
  outbox → drainer → socket-fanout chain honesty, `RUN_WORKER_INLINE` assumptions,
  Prisma pool sharing (`setSharedDb` proxy), env vars referenced vs validated vs in
  compose, e2e specs vs current routes.

Every reviewer prompt must include: the ground rules from §0 (verbatim summary), its
domain's file list from the map, and the instruction to return findings as structured data:
`{file, line, severity: HIGH|MED|LOW, dimension, summary, failure_scenario, suggested_fix}`.
Findings without a concrete failure scenario ("could be cleaner" with no consequence) go in
a separate `polish` list, not `findings`.

## 4. Phase 3 — Adversarial verification (barrier: dedupe first)

Dedupe all findings by (file, root cause). Then for each finding spawn verifiers prompted
to **REFUTE** it by reading the actual code and tracing the actual path:

- HIGH findings: 3 verifiers with distinct lenses (correctness / does-it-reproduce /
  is-it-already-guarded), majority rules.
- MED/LOW: 1 skeptic verifier.
- Any finding matching the refuted/accepted lists in §0 requires the verifier to quote the
  code that proves it real despite the documented refutation — otherwise kill it.

Output: `confirmed[]` ranked by severity, `refuted[]` with reasons. Log counts.

## 5. Phase 4 — Fix fan-out

Fix every confirmed finding. Rules for fixer agents:

- Minimal, idiomatic diffs — match surrounding code's style, comment density, patterns.
  Reuse existing helpers (`withTransientRetry`, `createTokenBucket`, `statusWinsOver`,
  `withCorrelation`, publishInTx, the `_mutex` helper) before writing new ones.
- Schema changes go through `prisma migrate dev` with a descriptive name; call out every
  new migration in the final report (they gate the deploy).
- Realtime fixes must patch **both** reducer consumers and all three recovery paths, or
  the fix is incomplete — verifiers should reject partial wirings.
- Group findings that touch the same file into one fixer to avoid conflicting edits; if
  parallel fixers must touch overlapping files, serialize them instead of using worktrees
  (the shared-tree/concurrent-session rule in §0.7 makes worktree merges risky here).
- Each fixer returns: what it changed, why, and how it self-checked.

Then run a **fix-review pass**: fresh reviewers re-read every diff hunk for regressions,
rule violations (§0), and incomplete wirings. Fix what they confirm.

## 6. Phase 5 — Verification gates (run inline, in order)

1. `pnpm typecheck` — both apps green.
2. `pnpm lint` — green.
3. `pnpm exec prisma validate` (+ `prisma migrate status` if migrations were added).
4. Boot smoke: `pnpm web:dev` + `pnpm api:dev`, wait for both, `curl :4000/health` and
   `curl :3000/api/health` healthy, then a manual round-trip via the dev emit tool if
   webhook-path code changed.
5. **e2e**: run Playwright against the dev stack (web :3000 + api :4000; Next rewrites
   make it same-origin). Known environment gotchas: if :3000 is held by an invisible
   Windows-side server, run web on :3100 with temporary dev-CORS additions in `main.ts` +
   `ws-adapter.ts` and **revert them after** (zero temp markers left in the diff).
   Baseline: ~198 passed with 2 known `calls.spec` preflight failures
   (`provider_not_configured` — the no-Meta-calls-provider env gotcha). **The bar is: no
   NEW failures vs that baseline**, and a cold-start `page.goto` timeout retried warm
   doesn't count. To free a stuck :3000, kill the `next-server` PID first, then the pnpm
   supervisors.
6. If any gate fails: diagnose, fix, re-run the gate. Never report done with a red gate,
   and never weaken a test to make it pass.

## 7. Phase 6 — Loop until dry

After gates pass, run a second discovery round: a smaller pool of fresh reviewers over the
highest-risk domains (messages/send paths, webhook ingest, workflow engine, realtime
reducers, team-chat) plus every file the fix phase touched. New confirmed findings →
back to Phase 4. Stop when a full round yields zero confirmed findings, then run one
**completeness critic**: "which domain, dimension, or integration seam got no coverage;
which fix was never exercised at runtime; which claim in the final report is unverified?"
Address what it finds.

## 8. Final report (the user reads only this)

Deliver in your final message, in plain prose + short tables:

1. **Verdict** — one sentence: is the app production-solid, and what changed.
2. **Fixed** — each confirmed finding: severity, one-line defect, one-line fix, files.
3. **Refuted** — notable scares that turned out false, with the one-line proof.
4. **Deferred/accepted** — anything real but out of scope, with the trigger to revisit.
5. **Gates** — exact results: typecheck, lint, prisma, boot smoke, e2e pass/fail counts
   vs baseline, plus any new migrations pending deploy.
6. **Tree state** — what's staged/committed vs left in working tree; explicit reminder
   that deploy/push remains user-gated.

Be honest to the letter: a skipped step is reported as skipped, a flaky pass as flaky.
No trophy language — the report's value is that every line of it is load-bearing.
