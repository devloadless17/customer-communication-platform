# Realtime Model

Deep-dive companion to [CLAUDE.md](../CLAUDE.md). Realtime correctness is the highest-quality bar in the app — the inbox must feel instant and never show stale, duplicated, or flickering state. The rules below are load-bearing; each has a real bug behind it.

Guiding principle: **emit only after a successful state change; small, scoped, idempotent frames; never speculative, never duplicate, never unchanged.**

---

## 1. Transport & rooms

Socket.io lives in the **NestJS process** (same process as REST + webhooks + workflows = in-process emit, zero pub/sub hop). Browser connects through Caddy → NestJS gateway.

- Gateway: `apps/api/src/realtime/realtime.gateway.ts`
- Emitter: `apps/api/src/realtime/emitter.service.ts` — `RealtimeEmitter.emitToTeam / emitToConversation / emitToChannel`
- Room names (single source of truth): `apps/api/src/realtime/rooms.ts` — `team:${teamId}`, `conv:${conversationId}`, `chan:${channelId}`, `user:${userId}`
- Adapter tuning: `apps/api/src/realtime/ws-adapter.ts` — `path = /api/socket`, `connectionStateRecovery.maxDisconnectionDuration = 30s`, `maxHttpBufferSize = 64 KiB`, `perMessageDeflate = false`, `pingTimeout 20s / pingInterval 25s`, CORS pinned to `BETTER_AUTH_URL`.

On connect a socket auto-joins its `team:` room and its `user:` room. Conversation rooms are joined on demand (`subscribe:conversation` / `unsubscribe:conversation`); channel rooms via `subscribe:channel` (membership-gated). The handshake reuses the HTTP session resolver (`resolveSession`), so socket auth is the same cookie path as REST.

**Connection-state-recovery is bounded at 30 seconds** (was 2 min — a memory cliff). After a longer offline (laptop sleep, WiFi hop), non-displayed cached threads are evicted on reconnect and refetched on click; the *displayed* thread is full-refetched by `useConversationEvents`. Both are the same answer — refetch, don't build a replay layer. **Don't extend this window.**

---

## 2. Fanout scoping (`fanout-rules.ts`) — DO NOT REGRESS

`apps/api/src/realtime/fanout-rules.ts` maps each `DomainEventType` to a wire emit. The `FanoutRuleMap` is a `Record` over *every* event type, so a new domain event is a **compile error here** until you either write a handler or explicitly opt out with `null`.

Scope discipline:

- **`emitToTeam`** — every agent in the team needs it: `message:new`, `conversation:status`, `conversation:assigned`, `conversation:read`, `contact:updated`.
- **`emitToConversation`** — only thread viewers: `message:status`, `message:media:ready`, typing, `conversation:viewers`, and **broadcast recipient frames** (`broadcast.recipient_message_sent` → `message:new`, `broadcast.conversation_reopened` → `conversation:status`). Broadcast frames are conversation-scoped on purpose — a 10k-recipient broadcast would otherwise storm the team room at ~625 frames/sec.
- **`emitToChannel`** — team-chat channel-scoped only.
- `message.status_changed` was deliberately moved from team → conversation room (only the viewing thread consumes it).
- `contact.tag_changed` and `contact.lifecycle_changed` map to `null` (no socket subscription) — the narrow events still drive outbound-webhook routing; the coalesced `contact.updated` frame carries the UI update.

Bulk paths set `suppressSocketFanout: true` on per-row events and emit one coalesced `contact.bulk_updated` frame instead (a 500-contact × 25-agent op goes from ~12,500 frames to 25). Audit/workflow/webhook subscribers don't read the flag — they still see every per-row event.

---

## 3. Frontend reducer → consumer contract

The single source of truth for applying a socket frame to per-thread state is the **pure reducers** in `apps/web/src/features/inbox/lib/thread-reducers.ts`. Reducers return the *same reference* (`prev`) when nothing changed, and use `findIndex`-then-`slice` (not `map`/`filter`) to avoid allocating on a no-match.

Three consumers apply the same reducers — wire a new event in ALL of them or a chat-switch reverts the field to a stale snapshot:

1. `useConversationEvents` (`apps/web/src/features/inbox/hooks/use-conversation-events.ts`) — the live displayed thread.
2. `inbox-shell.tsx` — the LRU `ThreadCache` snapshot of non-displayed threads.
3. `contact-panel.tsx` — the contact side-panel.

Wiring is table-driven: a `THREAD_REDUCER_EVENTS` array of `reducerEntry({ event, apply, target? })`. Both consumers iterate the array, so adding an entry auto-wires them. `target: "all"` (only `contact:updated`) means "no conversationId in payload; walk every cached thread and let the reducer bail on non-match."

Supporting invariants in the same file:

- `COALESCED_LIVE_HOOK_EVENTS = { "message:status" }` — the live hook RAF-coalesces these (status bursts pinned CPU at 100% during broadcasts); the cached shell applies them directly (Map mutations need no React batching).
- `REDUCER_EXCLUSIONS` — a `Map<event, reason>` for events that deliberately skip the table (`message:new`/`note:new` = list mutation; `message:failed` = optimistic-row; `contacts:bulk_updated` = coalesced; `conversation:deleted` = navigation; `call:sdp_offer` = WebRTC signaling owned by `useCall`).
- `assertReducerCoverage(subscribedEvents)` — dev-only invariant that **throws** if a subscribed event is in neither the table nor the exclusions map. This catches the "stale-cache six months later" bug class at dev time.
- **Monotonic status guard (`applyMessageStatus`)**: `STATUS_RANK { pending:0, sent:1, delivered:2, read:3, failed:4 }`; only advances rank, never regresses. Meta delivers status webhooks at-least-once and unordered; `failed` is terminal. Mirrors the server-side rank guard.

---

## 4. Read-state & reconnect convergence — the recurring bug class

Inbox unread is **team-wide only** (`Conversation.unreadCount`). There is NO per-agent inbox read state (team chat has its own, `TeamChannelReadReceipt`). `applyConversationRead` zeroes the counter for everyone when any member marks read.

Three load-bearing rules; breaking any one is the "stuck / wrong unread" bug class:

### Rule 1 — `markRead` fires ONLY when the agent is actually viewing (visible AND on the thread)
Triggers in `use-conversation-events.ts`:
- **Mount** — on *every* visible mount. It does NOT gate on the cached `unreadCount` snapshot, which can be stale-low on a client-side chat-switch and leave the DB counter stuck-high. The server `markRead` short-circuits the already-read case with one cheap SELECT and sends no redundant Meta read-receipt, so the over-call is negligible.
- **Live `onMessageNew`** — gated on `document.visibilityState === "visible"`, else deferred via `sawInboundWhileHiddenRef`.
- **`onVisibility`** — fires the deferred read on return.
- **Agent SEND** — also marks read server-side (`MessagesService.markReadOnAgentSend`); replying is proof of viewing.

A hidden background tab parked on a thread must NOT clear team-wide unread for a message nobody saw — that silently drops customer messages from triage. This is the app's most-guarded invariant.

### Rule 2 — every recovery path converges to server state
The displayed thread has three recovery paths:
- **Live socket reducers** — steady state.
- **Delta backfill (`runBackfill`)** — on first connect / open: `GET …?after=<latest server timestamp>&id=<tail id>` closes the SSR-render → socket-subscribe gap. SSR is fresh, so a delta suffices.
- **Full refetch (`runFullRefetch` → `GET /api/inbox/conversation/:id`)** — on a real reconnect-after-drop: the delta can't carry notes / contact / message-status that changed while offline.

First connect = delta; a subsequent connect (reconnect) = full refetch; a first connect from a possibly-stale cache upgrades to full refetch. Both clear unread when `unreadCount > 0`. Wire any new unread-clear or thread-state trigger into ALL paths.

Storm control: recovery is skipped when the tab is hidden or `navigator.onLine === false` (deferred to the visibility/online listener). Reconnect recovery gets 0–1500 ms jitter to break the synchronized post-deploy reconnect storm; first-connect open runs immediately. Jittered timers are tracked in a `Set` and cleared on unmount so a thread-switch mid-jitter can't fire `runFullRefetch` (and its `markRead` side-effect) for the OLD conversation.

### Rule 3 — the list badge clears via a LOCAL `conversation:read` dispatch, not the server frame
`markRead`'s server-side CAS publishes `conversation.read` ONLY on the `1→0` transition — it's one-shot. Once the DB unread is zeroed, no future frame fires, so a single missed delivery (socket not yet joined to the team room, a throttled tab, a transient drop) would leave the LIST badge stuck at >0 forever.

Fix: `inbox-shell.tsx`'s `handleMarkRead` fires `dispatchLocalSocketEvent("conversation:read", …)` on POST success. That one local frame drives all three consumers through their already-wired reducers — `useTeamEvents.onRead` (list badge), the inbox-shell reducer (LRU snapshot), and the `useConversationEvents` reducer (live `data.unreadCount`, so snapshot-on-leave can't write a stale 1 back). Don't make the list badge depend on the server round-trip frame again — it follows the same optimistic-socket-dispatch rule as every other inbox mutation.

---

## 5. Team-chat parallels

Team chat has its own (separate) realtime graph: `use-team-events.ts` (team room auto-joined + head-resync on every connect), `use-team-channel-events.ts`, `use-team-channels-events.ts`, `use-thread-events.ts`. Same reducer/converge philosophy, distinct from the customer-message graph — never cross-wire them.

---

## 6. Presence vs availability vs working hours

Three orthogonal signals; keep them distinct.

- **Presence** — "has ≥1 live socket". In-memory only (`PresenceService`), never persisted, broadcast as `presence:update`.
- **Availability** — the per-user status badge (`available` / `busy` / `away` / `offline`), persisted on `User.availabilityStatus` and broadcast as `user:availability:updated` (+ a one-shot `user:availability:snapshot` on connect). `offline` is *"Appear offline"*, not "disconnected".
- **Working hours** — an optional schedule (org default on `Team.workHours`, per-member override via `User.workHoursMode`/`workHours`) that *derives* availability.

**`availabilityStatus` is the EFFECTIVE value** — what every reader renders (dots, sidebar, assignment dropdown, "also viewing", round-robin eligibility). What the person actually picked lives separately in `availabilityManualStatus`/`Message`, so an off-shift stretch never destroys the note they typed. The rule lives in exactly one function, `resolveEffectiveAvailability` (`@ccp/shared/presence`):

1. No schedule → the manual pick, forever (identical to pre-working-hours behavior; the default for every un-configured team).
2. `availabilityOverrideUntil` still in the future → the manual pick.
3. On shift → `available`, manual note dropped.
4. Off shift → `away` + "Outside working hours · back Mon 09:00".

A fresh manual pick sets `availabilityOverrideUntil` to the **next schedule boundary**, so an override can never outlive the shift that motivated it — the whole point of the feature. Three cases the anchor has to get right, each with a test behind it:

- **No schedule** → `null`, i.e. no expiry. The pick holds forever, exactly as availability behaved before working hours existed.
- **A 24/7 schedule** (every day `00:00`–`00:00`, so the windows chain and it never closes) → there is no boundary, so the anchor falls back to the **next local midnight in the schedule's timezone**. Returning `null` here would be a bug, not a simplification: `null` means "no override", so the schedule would reclaim the status on the very next resolve and a round-the-clock team could never mark itself busy at all.
- **The schedule changes while an override is live** → the expiry is **re-anchored** to the new schedule (`intent: "rescheduled"` in `apply.ts`, used by every schedule-edit path). Its old value pointed at a boundary that may no longer exist; without re-anchoring, shortening a shift from 17:00 to 12:00 leaves a 14:00 pick running until 17:00 — breaking the one invariant the feature exists for.

**Round-robin**: an off-shift member is `away`, so they drop out of the "online + available" and "available" tiers. They are *not* excluded outright — the last-resort "any active member" tier still exists so a conversation is never orphaned when the whole team is off shift. Teams that want strict presence use the assignment policy's `eligibility` setting.

**One writer**: `apps/api/src/lib/availability/apply.ts`. The self route, the admin route (`availability:manageOthers`), and the 60s `work-hours` sweeper all funnel through it, so the columns, the override expiry, and the `user.availability_changed` event can't drift apart. It no-ops (no write, no frame) when nothing actually changed — load-bearing, since the sweeper calls it for every scheduled member every minute.

Client note: `user:availability:updated` carries an extra `manual` object. **Only the user's own availability picker reads it** — teammates render `status`/`message`. Without it, an off-shift agent's own note box would fill with "Outside working hours" and save that back as their personal note.


### `message:flag`

Team-scoped frame for triage-flag changes (add / update / resolve / remove).
Carries `conversationId`, `messageId`, the flag and the conversation's
`openFlagCount`.

Consumers must COALESCE it: it is team-wide, so one agent bulk-triaging a queue
produces a burst. The `/flags` queue debounces its refetch for exactly this
reason; the inbox applies it through the shared thread reducers.

Under agent conversation-visibility scoping the frame follows the same rule as
every other conversation frame — see [assignment.md](assignment.md).
