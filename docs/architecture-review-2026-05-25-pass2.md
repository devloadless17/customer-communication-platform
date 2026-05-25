# Architecture Re-Audit (Pass 2) — 2026-05-25

**Scope:** Full from-scratch 13-area re-audit, independent of the earlier
[architecture-review-2026-05-25.md](architecture-review-2026-05-25.md). Run AFTER
this session's F2–F6 fixes landed AND after the role-permissions feature shipped.
Seven parallel deep-dives + direct verification of every "critical" claim before
write-up (per [project_external_reviews_vs_locked_decisions] — agents overstate).

**No code changed for this review.** Read-only audit + prioritized backlog.

---

## TL;DR

The system **re-certifies production-grade**, again. The earlier pass's fixes
(F2–F6) all verified present and correct in code. The independent re-derivation
confirmed the earlier verdicts on workflows, events/realtime, message pipeline,
identity, and custom fields — all SAFE.

**This pass found 3 genuine NEW items the earlier audit could not have caught** —
two because the role-permissions feature shipped *after* it, one a retention table
that slipped through:

| # | Severity | Area | One-liner |
|---|---|---|---|
| N1 | **MEDIUM** | Permissions | Tags & snippets mutations are **ungated** while sibling catalog mutations (stages/contactFields) are capability-gated — inconsistent; an agent can delete team-wide tags/snippets |
| N2 | **MEDIUM** | Retention | `ConversationEvent` (audit timeline) has **no retention sweeper** — only high-churn table that grows forever |
| N3 | **LOW** | Soft-delete | Workflow steps + /v1 contact lookups don't filter `deletedAt` — narrow, self-healing window (revive-on-ingest), not the "critical" an agent flagged |

Plus the **still-open F1** (multiple WhatsApp accounts) — unchanged, pre-scoped,
deferred by design.

**Two agent "findings" were WRONG on verification and are dismissed** (see end).
**Biggest risk remains over-tinkering** — N1/N2 are small, surgical fixes; N3 may
not be worth touching at all.

---

## Part 1 — Verified re-confirmations (the earlier verdicts hold)

Re-derived independently from code this pass; all SAFE. Brief, since these match
the prior doc — listed so you know they were genuinely re-checked, not copied.

- **Workflows** — loop-safe: `TRIGGER_DEPTH_MAX=8` ([steps/trigger-workflow.ts:41]),
  `MAX_STEPS_PER_RUN=100` counted by distinct stepId ([runner.ts]), DAG cycle
  detection at publish ([graph.ts]), all mutating steps `silent:true`, graph
  snapshot pinned at run creation, BullMQ 3-attempt bound, once-per-contact ledger
  transactional. Execution model is a linear state machine — no hidden recursion.
  *New sub-note:* backward `jump_to_step` can loop within a run but is bounded by
  the 100-step ceiling + optional per-step `maxJumps` — acceptable.
- **Events / realtime** — one central in-process bus, `SubscriberPriority` enforced
  by sorted insertion ([bus.ts:65-122]), no fanout handler calls `publish()` (no
  feedback loop), broadcast events conversation-room-scoped (storm guard),
  `suppressSocketFanout` + `contact.bulk_updated` coalescing, transactional outbox
  with at-most-once via `UPDATE…WHERE publishedAt IS NULL…FOR UPDATE SKIP LOCKED`,
  30s reconnect recovery + refetch. Payloads small, scoping correct, no N+1 in
  fanout. Genuinely fast/smooth as designed.
- **Message pipeline** — inbound dedup `(teamId, channel, externalId)` + 200-on-dup,
  one-tx atomicity with `publishInTx`, outbound `OutboundSendAttempt` double-send
  guard (re-publishes without re-calling Meta on retry-after-success), monotonic
  status rank, bounded send retries + `message.send_failed`, 2-phase inbound media +
  sweeper. No lost-message or duplicate-send path.
- **Webhooks / integration** — `X-CCP-Depth` cap 8, `incoming_webhook` HMAC +
  ±5min replay window + Redis idempotency, outbound delivery 4-attempt + stable
  `X-CCP-Delivery` + circuit breaker @20, **F6's `correlationId`/`X-CCP-Trace-Id`
  verified live**.
- **F2 verified** — `ApiIdempotencyService` ([external/v1/api-idempotency.service.ts])
  is wired into **every** /v1 mutation: sends, assign, status, tag add/remove,
  contact update, and the by-contact variants (via `withIdempotency` helper +
  `*Internal` splits). No mutation route left unprotected **except `upsertContact`**
  (see N-minor below).
- **Identity / custom fields** — partial phone-unique (WhatsApp) + compound unique
  (channel, externalContactId), F4 TODO marker present at [ingest.ts:386]. Custom
  fields Zod-capped (50×80×500), flat, GIN-indexed, indexed filter. CLEAN.
- **Contact/Conversation ownership** — clean split, no dual-owned field; denorms
  (`lastInboundAt`, message counters) have reconciliation sweepers (incl. F3's new
  analytics-drift). CLEAN.
- **DB indexes / cascade rules** — all hot-path keyset + trigram indexes present;
  cascade (Team) vs SetNull (User-authored) vs soft-delete (Contact) all correct.
  `deletedAt: null` filter applied consistently across all directory/list/search/
  count/export/audience/forward query sites. ContactStage delete refuses-if-in-use;
  Tag delete non-destructive by design.
- **F3 + F5 sweepers verified** — both `conversation-analytics-drift` and
  `auth-table-cleanup` wired into `workflow-worker.service.ts` START **and** STOP.

---

## Part 2 — Genuine NEW findings (verified by hand)

### N1 — MEDIUM: Tags & snippets mutations bypass the new permission model

**The role-permissions feature gates the team-catalog mutations it considered —
but missed two siblings.** Gated today (via `@RequireCapability` / handler
`resolvePermissions`):

- `stages:manage` → POST/PATCH/DELETE/reorder `/api/team/stages`
- `contactFields:manage` → POST/PATCH/DELETE `/api/team/contact-fields`
- plus `broadcasts:manage`, `templates:manage`, `audienceGroups:manage`,
  `contacts:delete`, `conversations:delete`.

**NOT gated** (verified — zero `@RequireCapability`/`@RequireRole` on the handlers):

- `/api/team/tags` POST / PATCH / DELETE ([tags.controller.ts:54,63,73])
- `/api/team/snippets` POST / PATCH / DELETE ([snippets.controller.ts:46,55,65])

And there is **no `tags:manage` / `snippets:manage` capability** in
`ALL_CAPABILITIES` ([permissions.ts:113-121]) at all.

**Why it's a real inconsistency:** tags and snippets are **team-wide shared
catalog** exactly like stages and contact-fields — renaming or deleting one affects
every agent's inbox. The feature's own design intent gated stages/fields for that
reason; tags/snippets are the same tier but any agent can create/rename/delete them.

**Severity MEDIUM not HIGH:** it's disruption/governance, not a security or
data-loss hole (tag delete is non-destructive — just removes the label; snippet
delete loses a canned response). And pre-feature, these were ungated too, so it's
not a *regression* — it's an *incomplete rollout* of the new model.

**Fix (small, mechanical, matches the existing pattern):** add `tags:manage` +
`snippets:manage` to `ALL_CAPABILITIES` + `CAPABILITY_LABELS` + `DEFAULT_CAPABILITIES`
(default `true` for manager/agent to preserve today's behavior), then
`@RequireCapability("tags:manage")` / `("snippets:manage")` on the six handlers.
The UI settings grid auto-picks up new capabilities (single source of truth in the
shared package — verified no drift), so no UI change needed. ~30 min.

> Decision needed: default the new capabilities to `true` (preserve today — agents
> keep managing tags/snippets unless an admin restricts) vs `false` (lock down by
> default). Recommend `true` to match the feature's "defaults preserve-today" rule.

### N2 — MEDIUM: `ConversationEvent` audit log has no retention sweeper

Verified: **no sweeper in `lib/sweepers/` touches `ConversationEvent`.** Every
other high-churn table has one — `WorkflowRun` 30d, `OutboundWebhookDelivery` 30d,
`OutboundEvent` 7d, `OutboundSendAttempt` 7d, `ApiIdempotencyKey` 24h, Session/
Verification (F5). `ConversationEvent` is the one that slipped through.

It's append-only — one row per assign / status / tag / stage / note change, forever
([schema.prisma:1520]). It cascades on conversation delete, so it's bounded by live
conversations, but on an active account it's the **fastest-growing audit surface**
after `Message`. At pilot scale it's nothing; by month 3–6 of real use it bloats
`pg_dump` and slows the (future) history-panel queries.

**Fix:** a daily retention sweeper mirroring `outbound-event-retention.ts`, deleting
rows older than N days (90d is a reasonable default; make it
`CONVERSATION_EVENT_RETENTION_DAYS`-configurable). The index `[conversationId, at]`
already exists; add `[at]` or `[teamId, at]` if the delete needs it. ~45 min.

*Contrast with `Message.rawPayload`:* that one is unbounded **by design**
(CLAUDE.md rule #4, debugging) and stays so until the documented ~1M-msg/month
cliff. `ConversationEvent` has no such justification — it's just missing.

### N3 — LOW: Workflow / `/v1` contact lookups don't filter `deletedAt`

The workflow step lookups ([steps/tag.ts:69], [steps/update-field.ts:74],
[dispatcher.ts:270]) and some /v1 contact reads do `findFirst({ id, teamId })`
without `deletedAt: null`, so they *can* operate on a tombstoned contact.

**An agent's deep-dive flagged this CRITICAL. On verification it is NOT.** A
soft-deleted contact **revives on ingest** (the upsert clears `deletedAt`) *before*
any inbound-triggered workflow runs — so by the time a workflow step touches the
contact, it's live again. The only real window is a workflow firing on a contact
that was soft-deleted *between* events (e.g. a scheduled/awaiting-reply resume), and
even then the effect is a mutation on a hidden row that self-heals on the contact's
next message. No data loss, no cross-tenant leak, no loop.

**Recommendation:** LOW. Optionally add `deletedAt: null` to those lookups for
defensive consistency, OR leave it — the revive-on-ingest semantics already make it
benign. I'd lean **leave it** unless you want belt-and-suspenders; adding filters to
N lookup sites is churn for a self-healing edge case. Your call.

*Related (also LOW, same root):* `WorkflowContactState` / `WorkflowAwaitingReply`
rows for a soft-deleted contact persist (cascade only on hard-delete). Consequence:
a revived contact won't re-fire a `triggerOncePerContact` workflow. That's arguably
**correct** ("once per contact" should survive a soft-delete round-trip), so I'd
classify it as intended, not a gap.

---

## Part 3 — Minor / nits

- **`upsertContact` lacks idempotency** ([external-v1.service.ts]). The one /v1
  mutation F2 didn't cover. Low risk — it's find-or-create by phone, already
  naturally near-idempotent (re-upsert of an active row patches; the only
  double-fire is `contact.created` on a soft-deleted revive). Wrap it with the
  existing `withIdempotency` helper if you want full coverage. ~10 min.
- **Workflows are admin-only, not capability-gated.** Can't delegate workflow-
  building to a manager without full admin. Design limitation, not a gap — add a
  `workflows:manage` capability later if a customer asks.
- **API keys bypass team capability overrides** (they use their own scopes). Correct
  by design (keys are admin-issued), but worth one line in the docs so it's not a
  surprise.
- **Contact CSV import + create/update/assign/status are ungated** — intentional
  (per the feature's comments: sending a message isn't gated either; these are
  day-to-day agent work, not destructive catalog management). Confirm it matches
  intent; I read it as correct.

---

## Part 4 — Dismissed agent findings (verified FALSE)

Recording these so they don't get "re-discovered" next pass:

- **"LoginAttempt grows forever / security risk" — FALSE.** It self-cleans:
  `lockout.ts:94` does `deleteMany({ where: { email } })` on every successful login.
  Only failed-attempt rows for emails that *never* succeed linger, bounded to one
  small row per attacked email within the lockout window. NIT at most.
- **"Workflow steps mutating soft-deleted contacts — CRITICAL" — OVERSTATED.**
  Downgraded to N3/LOW above; revive-on-ingest makes it self-healing.
- **"Outbound webhook layer has no X-CCP-Depth cap" — not a real loop.** The
  `incoming_webhook` side caps at 8 and the `silent` flag stops the echo; a partner
  re-POSTing to /v1 starts a fresh, separately-bounded chain. No unbounded loop.

---

## Part 5 — Suggested action order

Everything here is optional; nothing blocks pilot. Value order:

1. **N1 (gate tags/snippets)** — closes a real inconsistency in the *just-shipped*
   permissions feature, while it's fresh. Small. *Worth doing.*
2. **N2 (ConversationEvent retention)** — the one missing retention sweeper; cheap
   insurance against month-3 bloat. *Worth doing.*
3. **upsertContact idempotency** — 10-min completeness fix on F2.
4. **N3 / WorkflowContactState** — likely leave as-is (self-healing / intended).
5. **F1 (multi-WhatsApp)** — still deferred; build on customer demand.

---

*Pass 2 verdict: production-grade, re-confirmed. F2–F6 fixes verified live. Three
genuine new items (N1/N2 worth fixing, N3 marginal), all small. The permissions
feature is sound except the tags/snippets gate gap. Over-tinkering remains the
dominant risk — resist "fixing" the SAFE list.*
