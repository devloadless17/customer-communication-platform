# Whole-App Perfection Audit — Orchestration Prompt (multi-channel)

> **How to use:** paste everything below the line into a fresh Claude Code session at the repo
> root (include the word **ultracode** at the top of your message to authorize multi-agent
> workflows). Nothing above the line is part of the prompt. Re-runnable: each run should
> converge — a clean run ends with "no confirmed findings" and green gates.

---

ultracode

You are the lead orchestrator for a full production-grade quality pass on this repository — a
**multi-channel shared inbox** (the Respond.io / Trengo / Front / Intercom / Missive class of
product): Next.js web + NestJS api + Postgres/Prisma + Redis/BullMQ + Socket.io, single VPS,
docker compose. Agents receive customer messages across many channels, reply, assign each other,
change status / stage / tags / custom fields, leave internal notes, run automations, place calls,
and send broadcasts — with **every state change reflected live to everyone on the team**.

Your mission: prove the whole app is **correct, solid, clean, fast, light, and simple** —
world-class, with every part verified to work *together across channels*. Spawn as many agents as
needed; token cost is not a constraint. Do not stop at "found issues" — find, adversarially
verify, fix, and re-verify until the app is dry of confirmed defects.

Read `CLAUDE.md` in full before anything else. It is law. Everything below assumes it. Read the
`docs/` deep-dives it links (events, realtime, identity, adding-a-channel, meta-channels-
capabilities, operations) — they are the contracts you audit against.

## The channel model — the spine of this audit

The product is **channel-agnostic**. The `Channel` enum is the ONLY discriminator; there is no
stored `provider`/`vendor` column. Every capability difference between channels is a declarative
flag in `@ccp/shared/providers/capabilities` (`CHANNEL_CAPABILITIES`), and app code derives
behavior from the flag — **never** from a hardcoded `if (channel === "whatsapp")`.

- **Live today:** `whatsapp`, `messenger`, `instagram` — all on the Meta Graph, but they are
  distinct CHANNELS (the channel is the medium, not the vendor), with different capabilities:
  WhatsApp has a 24h window + approved templates + full calling; Messenger/Instagram have a
  24h + 7-day-human-agent window, no templates, and calling only on Messenger (Meta ships no
  Instagram calling API). Instagram sends media by URL, not upload.
- **Designed-for, not yet built:** `telegram`, `email`, `sms` (+ the user intends TikTok, VoIP).
  The enum value + capability/identity/label maps exist so the architecture is ready;
  `LIVE_CHANNELS` / `isChannelLive()` gate them out of every row, picker, and send path.

**The central question of this audit:** if someone adds Telegram (or TikTok/email/SMS/VoIP)
next month by writing one `MessagingProvider` + one registry entry + one `ChannelConnection`,
does ingest, dedup, identity, realtime, workflows, broadcasts, templates, calling, and the `/v1`
API keep working with zero changes? Every place that would force an edit to the *core* to add a
channel is a **channel-agnosticism finding** — the seam has leaked.

## 0. Non-negotiable ground rules

These override any instinct you have:

1. **Locked architecture — do not re-litigate or "improve":** Socket.io lives in NestJS; Better
   Auth stays in Next.js; framework-agnostic `lib/` modules wrapped as Nest providers; Zod pipes
   (no class-validator); Prisma (no raw-SQL schema work); plain React state + pure reducers (no
   Zustand, no React Query, no Redux); Meta Cloud API only (no Baileys/Evolution); `channel` is
   the discriminator, never a stored "provider"; two processes, one VPS, no microservices. Do not
   suggest Pusher, Ably, Supabase, tRPC, GraphQL, Kafka, Kubernetes, or rewrites of any kind.
2. **Unified `Customer` identity is SHIPPED — audit it, don't propose it.** A `Customer` (person)
   owns many channel-scoped `Contact` rows; threads stay per-contact/per-channel (histories are
   never merged). Auto-merge is deterministic-strong-key ONLY: exact phone always; exact email
   **only when self-asserted** via the contact-share chip (`trustEmailAsStrongKey`, passed only
   by `contact-share.ts`) — an agent-typed or CSV email never auto-merges. No fuzzy/name matching,
   ever. Manual merge/split is reversible and non-destructive. (This REVERSES an old "no
   super-entity" rule from earlier audit prompts — that rule is dead.)
3. **Do not re-raise refuted findings.** Known-refuted with proof in this repo's audit memory:
   duplicate-Meta-send via tx-poisoning (send path idempotent via `OutboundSendAttempt`
   `@unique(jobId)`); the broadcast 131056 single-retry and `message.sent` no-retry (documented
   idempotent-safe — a 4^X backoff whose first step is 1s means our 3s retry is already more
   conservative than Meta's recommendation); session 401→forced-logout (client re-verifies). A
   verifier hitting one of these must quote code that proves it real despite the refutation, else
   kill it.
4. **Do not re-report accepted/deferred items as bugs.** Accepted list: filter-bulk 50k perf
   ceiling; whatsapp-phone TOCTOU (needs a functional-unique migration); single shared blob
   token; no encryption-at-rest for message bodies; in-memory rate limiting (single-instance);
   30s Socket.io recovery window; grow-only config caches (eviction deferred to 50–200 tenants);
   merge/split has no persisted audit record yet; the template composer UI can't yet bind
   button-params / named-vars (capability exists via `/v1` + workflows; broadcasts reject such
   templates up front); calling/WebRTC is unverified against a LIVE Messenger call (no live-call
   test harness exists). Name these once in the final report if relevant; never spend fix effort
   on them without asking.
5. **Do not re-add deliberately rejected UI patterns:** spinning avatars, pending-pulse, unread-
   cue removal, button `:not([width])`, node-ring offset, a `useEffect`-set "hydrated" boolean.
6. **"Behaviors that look fixable but are correct as-is"** in CLAUDE.md are correct as-is (e.g.
   the deliberate widening of `message.updated` fanout to team-room scope so cached background
   threads converge; the ANALYTICS-before-WORKFLOW event tier order).
7. **Scope discipline:** no new features, no *newly-built* channels, no new dependencies unless a
   fix is impossible without one (then ask). Making the abstraction READY for a future channel is
   in scope; shipping the channel is not. This is a hardening pass, not an expansion.
8. **This box runs concurrent Claude sessions on one shared working tree, and OOM-kills the dev
   servers under load.** Before any commit: `git status`, stage only your own hunks (`git apply
   --cached`), never `git checkout -- .` / `git reset --hard` / blind commit. **Do not push to
   main / trigger a deploy** — user-gated. **Before trusting ANY e2e result, `curl` both
   `:4000/health` and `:3000/login`** — turbo does not restart an OOM'd server, so a dead port
   looks like a mass regression. The authoritative suite result is one where both ports were
   verified alive at the end.

## 1. Phase 0 — Baseline (do this yourself, inline)

- `git status` + `git log --oneline -10` — record the starting tree (it may be intentionally
  dirty; treat the working tree as truth and read the pending hunks so you don't re-find fixes).
- `pnpm typecheck` (repo is **pnpm-only**, corepack-pinned — never npm/yarn).
- `pnpm lint` (`eslint .`; the 13 `no-floating-promises`/`no-misused-promises` items in
  `apps/api` are `warn`-level by design — 0 errors is the bar, not 0 warnings).
- `pnpm exec prisma validate` (Prisma 7 loads `.env` from cwd).
- Confirm `:4000`/`:3000` health if a stack is up; note the memory headroom (`free -m`).

If baseline gates are red, fix them first — everything downstream assumes green.

## 2. Phase 1 — Map (parallel readers)

Fan out read-only mappers so reviewers get a current picture (past audit notes are point-in-time;
verify against code). One mapper per cluster:

- **Backend modules** (`apps/api/src/`): admin, auth/guards, broadcasts, calls, common (pipes,
  guards, rate-limit, correlation), contacts, conversations, customers (identity/merge), db, dev,
  events (bus, outbox, drainer, subscribers), external `/v1`, health, invites, media, messages,
  notes, outbound-webhooks, realtime (gateway, ws-adapter, fanout, rooms), registration, team,
  team-chat, users, webhooks (Meta ingest), workflows.
- **Framework-agnostic lib** (`lib/`): messaging (the 4 send paths + text-cap + commit),
  conversations, contacts, identity (resolve/merge/contact-share), workflows engine, providers
  (meta, meta-social, capabilities, config-cache, page-subscription, ingest, ingest-call),
  events/bus, broadcast-runner, sweepers, queries, crypto, safe-fetch.
- **Frontend features** (`apps/web/src/features/`): inbox (thread-reducers, use-team-events,
  inbox-shell/LRU cache, reply-box, voice-recorder, attachments, contact-panel), contacts
  (browser, panel, import, bulk, person-hub), broadcasts (composer, recipients-preview), calls,
  workflows (React Flow builder, step editors), team-chat, templates, tags, audience-groups,
  settings, docs; plus shared: time rendering (`useTzNow`/`<LocalTime>`), socket client, channel
  badges/labels, capability-driven composer.
- **Shared contracts** (`packages/shared/`): events/types, socket/events, providers/types +
  capabilities, template-render, api-keys/scopes, utils/window + contact-share.
- **Data layer**: full `prisma/schema.prisma` — every model, unique, index, enum; pending
  migrations. Special: the `Channel` enum, `Contact` (identityChannel/phone/externalContactId/
  bsuid/version/soft-delete), `Customer`, the dedup uniques on `Message`/`Call`, `Conversation`
  `@@unique([teamId, contactId])`.
- **Infra**: `docker-compose*.yml`, Dockerfiles (heap caps vs mem_limits), `deploy/`
  (Caddyfile.template routes vs mounted routes), `main.ts` shutdown chain, env validation,
  `playwright.config.ts` + `playwright.meta.config.ts` + `tests/`.

Each mapper returns: responsibilities, entry points, invariants noticed, cross-module contracts
(events published/consumed, socket frames emitted/handled, capability flags read), and anything
that smelled off. Synthesize into a system map you keep in context.

## 3. Phase 2 — Domain × dimension review fan-out

Spawn one reviewer per (domain, dimension) cell that plausibly applies — expect 50–90 reviewers.
Dimensions, with what "perfect" means for each. **The channel-composition dimensions come first
because they are this audit's whole point.**

### Channel-composition dimensions (the spine)

- **Channel-agnosticism** — grep the WHOLE repo (api + web + shared) for `channel === "..."`,
  provider-name branches, `isPhoneChannel` misuse, and any core-path logic that would need
  editing to add Telegram/email/SMS. Each hardcoded discriminator where a capability flag exists
  or should exist is a finding. Verify `LIVE_CHANNELS`/`isChannelLive()` gate every leak point.
  Verify the provider registry + `getProviderBinding` is the only channel dispatch seam.
- **Per-channel message-type matrix** — for EVERY inbound and outbound kind (text, image, video,
  audio, voice note, document/pdf, sticker, location, contacts, interactive/quick-reply, buttons,
  reactions, edits, unsend/revoke, reel/story, referral/ad, unsupported) build the actual
  support matrix across whatsapp/messenger/instagram from the code, and find: a kind parsed on
  one channel but dropped to a placeholder on another for no capability reason; a media kind that
  uploads on one path and URL-sends on another inconsistently; MIME/size caps that disagree with
  the channel; a kind that silently loses data (no row, no rawPayload) instead of a labelled
  placeholder.
- **Identity across channels** — a person messaging on WhatsApp + Messenger + Instagram: does
  auto-merge fire only on the deterministic strong keys; can a PSID/IGSID collide with a phone or
  across teams; is a WhatsApp BSUID ever digit-stripped into a phantom phone (message AND call
  paths); is every identity resolution tenant-scoped; is merge reversible; does a
  `targetMode:"customer"` broadcast reach each person once on their best live channel.
- **State model across channels** — stages, tags, assignments, custom fields, status, notes must
  behave identically regardless of channel, and every state change must publish the right event +
  socket frame + (where relevant) outbound webhook + workflow trigger. Find a state mutation that
  works on WhatsApp but is wired differently (or not at all) for social, or that fans out on one
  channel and not another.
- **Calling across channels** — WhatsApp Business Calling + Messenger Calling (WebRTC), Instagram
  correctly refused (no API). Audit the full lifecycle (connect / call_status / media_update
  renegotiation / terminate), inbound vs outbound, permission request/reply, SDP handling, dedup
  on the Call unique key, terminate-before-connect and duplicate-terminate, orphaned-call
  sweeper. Mark anything not checkable without a live call as spec-unverified — do NOT claim it
  works.
- **Broadcasts + templates across channels** — templates are WhatsApp-only; the composer/runner/
  `/v1`/workflows must refuse them on social via the capability flag (not a hardcoded check) and
  still reach social users via freeform within-window; template component/param correctness
  (header/body/button, positional vs NAMED, media headers, category→billing); per-recipient
  channel routing for `customer` mode; the composer's predicted count == what the runner sends ==
  what the preview lists; the pacing knows media vs text rate limits per channel.

### Classic dimensions (still required)

- **Correctness** — logic bugs, races, unhandled rejections, wrong CAS/upsert semantics,
  off-by-one, TZ/locale, nullability. Special: webhook dedupe (`teamId+channel+externalId`
  compound unique, upsert-not-create on every inbound path), window gating, idempotency on every
  send path (messages, interactive, template, team-chat, broadcasts, workflow actions), the
  workflow engine's double-exec guards, BullMQ lock/graceful-shutdown interplay, the
  Meta-sends-first-commits-second ordering (a post-send commit failure must not release an
  idempotency claim → billed double-send).
- **Realtime convergence** — every socket event mutating per-thread state must be wired in ALL
  reducer consumers (live hook, LRU cache shell, contact panel); every recovery path (live socket,
  `?after=` delta backfill, full refetch on reconnect) converges to server state; unread is
  team-wide only, markRead only when visible+viewing, local `conversation:read` drives the list
  badge; frames emit only after a committed state change (a CAS that matched 0 rows must not
  publish); reducers return the SAME reference on a no-op frame. Check EVERY event in the reducer
  table, not just recent ones.
- **Performance** — N+1 Prisma (esp. list endpoints, inbox, contacts, broadcast recipient
  resolution, webhook enrichment, sibling-channel rollups); keyset not offset pagination; missing
  `select` narrowing; unbounded `findMany`; per-item awaits that should batch; socket fanout
  volume (bulk paths coalesce; broadcast.* never writes N audit rows / fires N workflows); React
  re-render storms (context splitting, memo on hot lists, virtualization); client bundles that
  should be RSC.
- **Security** — authz on every controller + the `/v1` surface (teamId never from client);
  API-key scoping + mandatory Idempotency-Key on sends + chain-depth guard; HMAC verify on every
  inbound webhook (raw body, timing-safe, the escaped-unicode subtlety for non-ASCII bodies);
  outbound webhook signing; SSRF safe-fetch on every provider/webhook/http_request fetch;
  envelope crypto for `ChannelConnection.secrets`; hashed API keys; rate-limit coverage; CSRF
  sameSite:lax (don't "fix"); XSS in rendered message/note/chat bodies; PII in error bodies/logs.
- **Resource safety** — memory growth (listeners, Maps, intervals, AbortControllers, grow-only
  caches), stream/file-handle cleanup, sweeper self-disable + mutex (no double concurrent run),
  worker re-entry guards (a Redis flap must not leak Workers/connections), heap ≤ ~75% mem_limit,
  timer leaks on unmount, graceful shutdown (`server.close()` before `app.close()`).
- **Simplicity / cleanliness** — dead code, duplicated logic that should share a helper (esp.
  across the 4 send paths, the 3 config loaders, the query builders), needless abstraction, a
  wrapper around one call site, files drifted from repo idiom, stale comments that CONTRADICT the
  code (there have been several — a comment claiming a feature is "Phase 3, not wired" when it is),
  TODOs past deadline, orphaned exports.
- **UX / product correctness** — the bar is Respond.io/Front/Intercom and better; the inbox is
  the highest-quality surface. Optimistic reconcile (pending→sent→failed, retry reuses the temp
  id); no silent failures; loading/skeleton/empty/error states; no layout shift / flicker /
  hydration-gated blank paint / lost scroll / focus loss; a11y on interactive elements; the
  composer/template/call UI derives from capabilities so a social thread hides the template
  button and an IG thread hides the call button.
- **Integration seams** — the cells most audits miss: Next↔Nest cookie-guard handshake; Caddy
  route table vs mounted routes; event bus → outbox → drainer → socket-fanout chain honesty
  (does a drained event carry every field its subscribers deref — a subscriber throwing on a
  missing field silently drops the delivery); `RUN_WORKER_INLINE`; Prisma pool sharing; env vars
  referenced vs validated vs in compose; `/v1` ↔ UI parity (every UI capability has a `/v1`
  counterpart, documented in BOTH `docs/organization-api.md` AND `apps/web/src/app/docs/api/
  page.tsx`); e2e specs vs current routes; the page-subscription field set vs what the parser
  consumes per channel (a subscribed-but-unparsed field, or a parsed-but-unsubscribed one).

Every reviewer prompt must include: the §0 ground rules (verbatim summary), the channel model
above, its domain's file list from the map, and the instruction to return findings as structured
data: `{file, line, severity: CRITICAL|HIGH|MED|LOW, dimension, summary, failure_scenario,
suggested_fix}`. A finding needs a CONCRETE failure scenario (specific inputs/state → specific
wrong output, lost data, double-send, leak, crash, or user-visible defect). "Could be cleaner"
with no consequence goes in a separate `polish` list, not `findings`. Prefer FEWER,
HIGHER-CONFIDENCE findings — a wrong finding costs more than a missed one. Tell reviewers that
"this domain is clean" is a valid, valuable answer; a padded list is worse than an honest one.

## 4. Phase 3 — Adversarial verification (barrier: dedupe first)

Dedupe all findings by (file, root cause). Then for each finding spawn verifiers prompted to
**REFUTE** it by reading the actual code and tracing the actual path, on distinct lenses:

- **refute** — is it already handled by a guard / upstream check / type / DB constraint / caller
  precondition? Is the path even reachable? Default to refuted when uncertain.
- **reproduce** — ignore the reviewer's reasoning; independently trace the exact scenario through
  the real code and cite the lines that cause or prevent it. No concrete repro → refuted.
- **rules** — does it actually violate a stated CLAUDE.md rule or cause real harm? Kill mere
  taste, invented rules, anything on the refuted/accepted lists, AND any finding whose suggested
  fix would add an abstraction without a real seam (§0.1 / CLAUDE.md §17 forbid that — the
  finding dies with its fix).

HIGH/CRITICAL: all 3 lenses, majority survives (refutes < 2). MED/LOW: at least the reproduce
lens. **Majority is a filter, not an oracle:** on any path that bills a customer, sends to a
customer, or is otherwise irreversible, read the code yourself before accepting a refutation —
in past runs the majority was wrong about a billed double-send that one dissenter traced
correctly. Output `confirmed[]` ranked by severity, `refuted[]` with one-line proofs, and the
list of dimensions that came back CLEAN. Log counts.

## 5. Phase 4 — Fix fan-out

Fix every confirmed finding. Rules for fixers:

- Minimal, idiomatic diffs — match surrounding style, comment density, patterns. Reuse existing
  helpers (`checkTextCap`, `outsideFreeFormWindow`, `commitOutboundSend`, `publishInTx`,
  `createOutboundMessageIdempotentDetailed`, `requiredTemplateButtonParams`, the config `TtlCache`,
  the `_mutex` helper, `toContactWire`, `workflowContactSnapshot`) before writing new ones.
- A channel-agnosticism fix replaces a hardcoded check with a capability flag — it must NOT add a
  new hardcoded branch elsewhere.
- Schema changes go through `prisma migrate dev` with a descriptive name; call out every new
  migration in the report (they gate the deploy).
- Realtime fixes patch ALL reducer consumers and all recovery paths, or the fix is incomplete.
- A new event field must be consumed by a real subscriber; a new frame must have a client handler
  — wire it end to end (type → fanout rule → socket event → client reducer) or it's incomplete.
- Group findings touching the same file into one fixer to avoid conflicting edits; serialize
  overlapping fixers rather than using worktrees (shared-tree rule).
- Each fixer returns: what it changed, why, and how it self-checked.

Then a **fix-review pass**: fresh reviewers re-read every diff hunk for regressions, rule
violations, incomplete wirings, and — critically — regressions the fix ITSELF introduced (a past
fix-pass introduced a HIGH broadcast cancel-retry regression). Fix what they confirm.

## 6. Phase 5 — Verification gates (run inline, in order)

1. `pnpm typecheck` — both apps green.
2. `pnpm lint` — 0 errors.
3. `pnpm exec prisma validate` (+ `prisma migrate status` if migrations were added).
4. Boot smoke only if a stack isn't already up: `curl :4000/health` + `:3000/login` healthy.
5. **Meta channel e2e** (the fast, deterministic, most relevant gate): `pnpm test:e2e:meta`
   (mock Graph + isolated api on :4001, Redis DB5). Baseline: 42/42. This exercises inbound
   parsing per channel, outbound send per channel, identity capture, `/v1` interactive +
   idempotency invariants, and calling webhook lifecycle against the mock.
6. **Full Playwright** against the dev stack (web :3000 + api :4000, Next rewrites = same-origin;
   `E2E_BASE_URL=http://localhost:3000`, `--retries=1` = CI policy). Baseline: **206 passed** with
   2 known `calls.spec` env failures (`.env` `CALLS_SKIP_PREFLIGHT=1` + team_1 whatsapp
   `isActive=false`). The bar is **no NEW failures vs baseline**; a cold-start `page.goto` timeout
   that passes on retry is a load flake (the two-tab-sync note test is a known one — verify
   isolated before investigating), NOT a regression. **Verify both ports alive at the end** or the
   result is void (OOM lies).
7. Any gate fails: diagnose, fix, re-run. Never report done on a red gate; never weaken a test.

## 7. Phase 6 — Loop until dry

After gates pass, run a second discovery round: a smaller pool of fresh reviewers over the
highest-risk domains (the 4 send paths, webhook ingest per channel, ingest-call, workflow engine
+ dispatcher, realtime reducers + fanout, identity/merge, broadcast-runner) plus every file the
fix phase touched. New confirmed findings → back to Phase 4. Stop when a full round yields zero
confirmed findings, then run one **completeness critic**: "which (channel × dimension) cell got no
coverage; which fix was never exercised at runtime; which claim in the report is unverified;
which future-channel seam was asserted-ready but never traced?" Address what it finds. Log what
was bounded or sampled — never let silent truncation read as full coverage.

## 8. Final report (the user reads only this)

Deliver in your final message, plain prose + short tables:

1. **Verdict** — one sentence: is the app production-solid across all live channels, and what
   changed.
2. **Channel-composition health** — a short matrix: for each of {inbound types, outbound types,
   identity, state model, calling, broadcasts/templates, realtime}, is it uniform across
   whatsapp/messenger/instagram, and is the seam ready for the next channel. Call out any place
   adding Telegram/email/SMS would force a core edit.
3. **Fixed** — each confirmed finding: severity, one-line defect, one-line fix, files.
4. **Refuted** — notable scares that turned out false, one-line proof each.
5. **Clean dimensions** — which (domain/dimension) cells came back with nothing (this is signal,
   not filler — it says where the code is genuinely strong).
6. **Deferred/accepted** — anything real but out of scope, with the trigger to revisit; and the
   honest unverified list (calling vs a live call; anything checked only against the mock).
7. **Gates** — exact results: typecheck, lint, prisma, meta-e2e vs 42, full Playwright vs 206,
   both-ports-verified, new migrations pending deploy.
8. **Tree state** — staged/committed vs working tree; explicit reminder that deploy/push is
   user-gated.

Be honest to the letter: a skipped step is reported skipped, a flaky pass as flaky, a mock-only
verification as mock-only. No trophy language — the report's value is that every line is
load-bearing.
