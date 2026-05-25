# Realtime / Chat Architecture Deep-Review — 2026-05-25

**Scope:** A from-scratch deep audit focused on the dimensions the owner cares
about for a realtime chat platform: **UX feel (lag/flicker/smoothness), frontend
render + state-layer boundaries, websocket/realtime layer, backend layering &
coupling, entity boundaries, and performance under load.** Complements the
correctness/security audits ([architecture-review-2026-05-25.md],
[architecture-review-2026-05-25-pass2.md]) which this does NOT repeat.

**Method:** 4 parallel code-level deep-dives (frontend-render, realtime/ws,
backend-layering, message-flow/load) + **hand-verification of every actionable
finding** before write-up (agents overstate — per [project_external_reviews_vs_locked_decisions]).
No code changed for this review.

---

## TL;DR — the architecture is genuinely realtime-native and well-layered

The system already implements almost everything the owner is asking for. The
deep-dives **confirmed the hard parts are right**: scoped emits, coalesced bulk
fanout, optimistic dispatch with `flushSync`, reducer-based cache patching, a
single event-bus decoupler, clean transport/domain/persistence separation, and
genuine swappability (Socket.io / BullMQ / channel each touch <10 files).

**Of the agents' raised findings, most were verified FALSE or overstated.** Three
"P0s" were dismissed on inspection (the code already does the right thing, in two
cases *better* than the agent proposed). What survives is **one genuinely worth
fixing** (status-frame storm on broadcasts) and a handful of micro-polish items.

**Biggest risk remains over-tinkering.** Do NOT "fix" the SAFE list.

---

## The ONE finding worth acting on — ✅ FIXED 2026-05-25

> **Status: DONE.** `message.status_changed` and the broadcast-only
> `broadcast.conversation_reopened` are now both `emitToConversation` (conversation
> room) instead of `emitToTeam`. Verified safe: `message:status` is consumed by
> exactly one client surface (the live thread hook, which already discarded
> non-displayed-thread frames) and the inbox list never listens to it; the
> broadcast-reopen frame is published from one broadcast-only site. Both typecheck
> green + smoke-booted. The team-room storm vector under broadcast load is closed.

### R1 — MEDIUM: `message.status_changed` fans out team-wide, uncoalesced

**File:** [apps/api/src/realtime/fanout-rules.ts:85-92] — `emitToTeam(teamId, "message:status", …)`, one frame per Meta status webhook, no batching.

**Why it matters (and is consistent with the owner's "no websocket storms" rule):**
Every outbound message gets 3 status webhooks from Meta (sent → delivered → read).
Regular 1:1 chat: negligible. But a **broadcast** is the storm case — the team took
great care to make `broadcast.recipient_message_sent` **conversation-scoped**
([fanout-rules.ts:260]) precisely to avoid team-room storms… and then the *status*
frames for those same broadcast messages still go **team-wide**. A 1,000-recipient
broadcast → ~3,000 `message:status` frames hit **every** connected agent tab,
each triggering a reducer pass, even for agents looking at an unrelated thread.

**Mitigating factors (why MEDIUM not P0):** the live thread hook already
RAF-coalesces `message:status` on the receiving side
([use-conversation-events.ts:806], `COALESCED_LIVE_HOOK_EVENTS`), so the *render*
cost is bounded; and the list hook ignores `message:status` entirely. So this is a
**network/parse** storm, not a render storm — real, but softer than it looks.

**Fix options (pick one, smallest first):**
1. **Scope `message:status` to the conversation room** instead of the team room —
   mirrors what `broadcast.recipient_message_sent` already does. Status only
   matters to someone viewing that thread (the list doesn't consume it). One-line
   change in the fanout rule + ensure status frames only reach subscribed viewers.
   *Risk:* an agent not subscribed to the conversation room won't get status ticks
   until they open it — which is exactly the desired behavior (they're not looking).
2. If you want list-level "✓✓" later, add a short (100-200ms) server-side coalesce
   window keyed by conversationId that emits the latest status per message.

**Recommendation:** Option 1. It's the same pattern already used one rule below it,
removes the only real storm vector under load, and aligns with "scoped emits only."

---

## Dismissed on verification (recording so they're not re-found)

- **"Inbound media download blocks the 200 / Meta retry-storm risk" (agent P0) —
  FALSE.** [meta.controller.ts:161-180] shows the media flow was *already* refactored
  to **fully async**: download kicks off in the background, rows commit immediately
  as `mediaPending`, the webhook returns 200 in <100ms, and `completePendingMedia`
  patches + emits `message:media:ready` when bytes land. The old 500ms in-band budget
  was **deliberately removed** for exactly the "instant bubble" reason the owner wants.
  *Stale memory:* [project_inbound_media_in_band] now describes the OLD behavior —
  update it.
- **"Unread CAS is a write-serialization hotspot at 50+ inbound/sec to the same
  conversation" (agent P0) — non-issue.** `{ increment: 1 }` inside Serializable
  ([ingest.ts:586]) is correct + race-safe. 50 msg/sec *to one conversation* = one
  human sending 50 WhatsApp messages/sec — impossible. Different conversations =
  different rows = no contention. The agent's "fix" (Redis counter) is exactly the
  premature complexity to avoid.
- **"Counts badge refetches 5 aggregates on every inbound" (agent P1) — overstated.**
  [use-conversation-counts.ts:100-103] gates the refetch on `payload.newConversation`
  ONLY (rare), with a comment saying so. Real cost exists only during a burst of
  *brand-new* conversations; bounded, not hot. See R3 below for the residual.
- **"`onMessageFailed` walks the whole thread, HIGH" (agent P0) — cold path.**
  [use-conversation-events.ts:792-803] is gated on `conversationId` + `clientTempId`
  and only fires on an actual *send failure* (rare). The `.map()` is a micro-nit
  (R4), not HIGH.
- **"Broadcast progress throttle race / unthrottled emits" (agent P1) —
  marginal.** Progress frames are already throttled to 500ms intervals
  ([broadcast-runner.ts]); the "race" is two frames in the same 500ms window at most,
  to the team room, during an active broadcast the agents are watching. Cosmetic.

---

## Worth a small fix (P2 — do opportunistically, none blocking)

- **R2 — Workflow steps mutate Prisma directly** instead of through a shared domain
  helper. ✅ **FIXED 2026-05-25.** Extracted `assignConversation()` /
  `setConversationStatus()` into [apps/api/src/lib/conversations/mutations.ts] (db +
  publish injected, framework-agnostic). ALL FOUR callers now route through it:
  `ConversationsService.assign/setStatus`, workflow `assign-to.ts` + `set-status.ts`,
  and `/v1` `assignInternal/setStatusInternal`. Closed three live drifts: (1) workflow
  assign-to now reopens a CLOSED conv to pending; (2) workflow `close_conversation` now
  UNASSIGNS on close (matching the UI); (3) `/v1` assign-to-closed now → pending (was
  → open, the stale rule). **Behavior change for existing workflows** — see note below.
  Typecheck green + smoke-booted (all 4 routes mounted).
  > ⚠️ Existing-workflow behavior change: a `close_conversation` step now clears the
  > assignee, and an `assign_to` step onto a closed thread now reopens it to pending.
  > Both are the intended unification, but if any live workflow *relied* on the old
  > (assigned-stays-on-close, or closed-stays-closed) behavior, it changes. Low risk
  > (the old behavior was the inconsistent one), but worth a glance at active workflows.
- **R3 — Counts recompute is 5 aggregates per viewing agent per new conversation.**
  Fine at pilot. If first-contact volume climbs (or a broadcast creates many threads),
  consider a per-team `ConversationCountSnapshot` row updated in-tx, turning 5
  aggregates into 1 SELECT. *Trigger to build it: >50 new conversations/min.* Don't
  pre-build.
- **R4 — `onMessageFailed` uses `.map()` not `findIndex`+`slice`.**
  [use-conversation-events.ts:797] — trivially match the other reducers' early-exit
  style. 2-line nit; do it next time you're in the file.

---

## SAFE / genuinely well-designed — DO NOT TOUCH

These were independently verified across the deep-dives. Listed so you know what's
load-bearing-and-correct.

**Realtime / websocket:**
- One socket-emitting bus subscriber at `REALTIME` priority; no fanout handler calls
  `publish()` (no feedback loop). [bus.ts]
- Emit scoping correct: team-room for list-relevant events, conversation-room for
  thread-only + broadcast recipient frames. `rawPayload` stripped before wire
  (`stripForWire`, [fanout-rules.ts:13]) — no JSONB/base64 leak to clients.
- Bulk coalescing: 500-contact tag bulk = **25 frames, not 12,500**
  (`suppressSocketFanout` + `contact.bulk_updated`). Verified.
- Socket auth is server-side (session cookie → guard), `teamId` from the trusted
  session, conversation-room join gated by DB ownership check. **No cross-tenant
  leak.** Deactivation re-checked on connect.
- Reconnect: 30s connection-state-recovery + full refetch on longer drops; no custom
  replay layer; no room leak/double-join.

**Frontend render / state:**
- `useChatScroll` — production-grade scroll stability (sticky-bottom, prepend anchor,
  media-decode-aware settle). Leave it alone.
- Reducer pattern (`THREAD_REDUCER_EVENTS`) wires both the live hook AND the LRU cache
  from one source; reducers bail without allocation. New events auto-wire both
  consumers. This is the right abstraction.
- `flushSync` optimistic dispatch ([socket-client.ts:173]) is what makes status/assign
  changes flip in the same frame as the rest of the UI — the thing that made the
  sidebar lag disappear. Correct and load-bearing.
- Memo discipline: `MessageThread` memoized, each bubble memoized, list rows memoized,
  conversation list virtualized (@tanstack/react-virtual). Only touched rows re-render.
- Filter-resync coalescing (50ms debounce + in-flight/queued flags) + the
  contact-overlay prune (the stage-filter fix this session). Converges; no refetch
  storm.
- Mark-read local-dispatch convergence (3 reducers, one frame). Correct.
- State layers have clear single-writer ownership (server-seed → LRU cache → live
  hook → optimistic → UI-only), documented in the `thread-reducers.ts` header +
  CLAUDE.md cache-patch matrix, and the code matches the docs.

**Backend layering / coupling:**
- Controllers are pure transport (zero Prisma in the 3 core controllers). Socket
  handlers contain NO business logic (only presence/typing infra + an ownership SELECT).
- Event bus is a real decoupler: producers don't know consumers; realtime / audit /
  workflow-dispatch / outbound-webhook subscribers are independent.
- Provider abstraction holds: Meta's wire shape is confined to `lib/providers/meta` +
  `ingest`; services consume `NormalizedEvent`. Adding SMS = new `Channel` value + new
  `MessagingProvider` + `ChannelConnection` (~6-8 files), as designed.
- Swappability verified by file-count: Socket.io ≈6 files, BullMQ ≈8-10, new channel
  ≈6-8 — the rest of the 200+ files are transport/queue/channel-agnostic.
- Exactly one `forwardRef` (MessagesService ↔ SendWorkerService) — idiomatic NestJS,
  not a smell. No circular module imports.

**Message flow / load:**
- Inbound dedup: `(teamId, channel, externalId)` unique + pre-check + Serializable
  retry + 200-on-dup. Zero duplicate-message path.
- Outbound idempotency: 4 layers (in-process lock → BullMQ jobId → `OutboundSendAttempt`
  → DB unique). No double-send / double-charge.
- Conversation summary monotonicity (lastMessageAt guards) — list order never reverses.
- Transactional outbox (`publishInTx`) — message + event commit atomically; no
  "saved but never emitted" gap.
- Broadcast runner: CAS claim, 10k in-process cap, 5-lane × 200ms (~25 msg/sec, under
  Meta's 80), graceful-shutdown resume. Sound.
- Hot-path indexes all present + correctly shaped (inbox keyset, thread keyset, trigram
  search, phone partial-unique, stage groupBy).
- In-memory structures all bounded (credential cache TTL+cap, idempotency LRU, send
  budget cap, presence auto-prune).

---

## Realistic first bottlenecks (anticipate, don't pre-build)

In order of when they'd actually bite, matching CLAUDE.md's existing cliffs:

1. **R1 status-frame storm** — bites the *first* time a large broadcast runs with
   several agents online. The only finding worth fixing proactively.
2. **2nd app instance** — needs the Redis Socket.io adapter (already documented as
   deferred). Single in-process emit is the current strength; it becomes the scaling
   wall here.
3. **Counts aggregates (R3)** — at high new-conversation volume.
4. **Broadcast >10k recipients** — move runner to a worker (documented).

None are present-day problems at pilot scale.

---

## Verdict

**Production-grade and realtime-native, re-confirmed from the chat/realtime angle.**
The system already embodies the owner's requirements — scoped emits, optimistic UX,
isolated layers, swappable transport/queue/channel, bounded memory. The single
worthwhile change is **scoping `message:status` to the conversation room (R1)** to
close the last team-room storm vector under broadcast load. Everything else is
polish (R2-R4) or already-correct. The dominant risk is over-tinkering the SAFE
list — resist it.
