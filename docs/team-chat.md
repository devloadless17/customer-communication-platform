# Team chat — channels, direct messages, visibility

Internal Slack-style chat between agents on a team. A **deliberately separate message graph** from the customer surface (`Conversation`/`Message`): no provider, no `externalId`, no direction, no status, no `rawPayload`, a different read-receipt cadence, and a different permission model. Keeping the graphs apart means a query against `Message` can never leak into team-chat results, and vice versa.

Entry point: `/team` → redirects to the team's default channel. Code: `apps/api/src/team-chat/**` (NestJS seam), `apps/api/src/lib/team-chat/queries.ts` (reads + DTO mapping), `apps/web/src/features/team-chat/**`.

**Not exposed on `/v1`.** The §12 UI↔API parity rule does not apply here — team chat is an internal surface, and `team_channel.*` events are explicitly excluded from outbound webhooks (`packages/shared/src/outbound-webhooks/public-events.ts`).

---

## 1. The model

One table, `TeamChannel`, backs three things. The discriminators:

| Column | Values | Meaning |
|---|---|---|
| `kind` | `channel` \| `dm` | What the row IS |
| `visibility` | `public` \| `private` | Who may JOIN (not who may read after joining) |
| `isDefault` | bool | The landing channel (`#general`) — undeletable, unrenameable, implicit membership |

`kind` and `visibility` are orthogonal to `isDefault`. `#general` is `isDefault: true, visibility: public`. Every DM is `kind: "dm", visibility: "private", name: null`.

**Why DMs reuse `TeamChannel` instead of getting their own tables:** a DM's confidentiality requirement is *exactly* what a private channel already enforces — `TeamChannelMember` + `requireChannelMembership` + `emitChannelScoped`'s fail-closed per-user fanout. A parallel model would have duplicated the whole service, the `team_channel.*` event taxonomy, every fanout rule, the `chan:` room gate, the media proxy, threading, and search, for zero security benefit. DMs inherit all of it for free.

### `name` is nullable

A DM has no name. Deliberately `NULL` rather than a synthetic `dm:<cuid>`: a synthetic name would leak into `WorkspaceSearchHit.channelName`, the page `<h1>`, and the sidebar filter, and would silently occupy the `@@unique([teamId, name])` namespace. NULL forces every consumer to be surfaced by the type checker. Postgres treats NULLs as distinct in a unique index, so unlimited DM rows coexist under that constraint unchanged.

### `dmKey` — the 1:1 guarantee

`dmKey` is the two participant ids **sorted and joined with `:`** (a self-DM is `"u:u"`), unique per team via `@@unique([teamId, dmKey])`. That constraint is what makes "open a DM with Sara" resolve to the same row no matter who opens it or how often.

**`dmKey` is ALWAYS derived server-side from the session user.** Never accept it — or a raw pair — from the client, or a caller could claim a conversation between two other people. `createOrGetDm` upserts against the constraint and re-reads on P2002 (never a bare `create`), so a simultaneous open from both sides resolves to one row.

**Self-DM is allowed** and becomes the notes-to-self surface. It needs no special handling: one member row, and `requireChannelMembership` / `emitChannelScoped` / member counts all tolerate a one-member channel unchanged.

---

## 2. Access model

### Reading: one gate, unbranched

`requireChannelMembership` (`channels.service.ts`) is the single spine for ~15 call sites — messages, threads, pins, member roster, media proxy, per-channel search, `around`, mark-read. It:

- short-circuits for `isDefault` (everyone is implicitly a member),
- otherwise requires an explicit `TeamChannelMember` row,
- and **404s rather than 403s**, so it never teaches a non-member that a channel exists.

**Public channels are join-to-read.** There is deliberately NO "public → allow read" branch in this function. Adding one would mean each of those ~15 call sites independently decides what a non-member may see. Browsing gets its own metadata-only endpoint instead.

### Joining

| | Browse | Join | Read |
|---|---|---|---|
| Public channel | yes | self-serve (`POST /:id/join`) | after joining |
| Private channel | no (404) | no (404) | members only |
| DM | never | n/a | participants only |

`joinPublicChannel` is idempotent (`createMany({ skipDuplicates })`) and publishes the **existing** `team_channel.members_changed` event — no new realtime code for the join path. **Leaving** needs no new endpoint either: `removeMember`'s self-leave path already permits any role, blocks the default channel, publishes `members_changed`, and evicts the socket from the channel room.

### Creating

`canCreateChannel(role, visibility)` — **public creation is open to everyone; private stays admin/manager.** A private channel is invisible in the browser and excluded from every other member's workspace search, so an agent-created one would be an ungoverned space with no discovery surface for anyone responsible for the team. Opening that up wants an admin-only "all channels including private" audit view first.

`canPinInChannel(role, kind)` — pinning is admin/manager in a channel, but **either party in a DM**: an admin who isn't in the DM can't reach it anyway, and a member shouldn't need permission to pin something in their own two-person conversation.

---

## 3. Non-negotiable invariants

1. **`assertNotDm` guards `update` / `remove` / `addMembers` / `removeMember`.** Without it, `POST /api/team/channels/:dmId/members` lets an admin inject a third party into two colleagues' private DM — and the existing `members_changed` fanout dutifully wires them into the room with full history. This is the single most important guard added with DMs.
2. **`createOrGetDm`'s target lookup carries `teamId` + `deactivatedAt: null`.** Without `teamId`, a client-supplied foreign userId plants a cross-tenant DM that surfaces in the *other* team's DM list. (`deactivatedAt` matches `addMembers`: you can keep reading an existing DM with someone who left, but you can't start a new one.)
3. **`kind: "channel"` filters** in `listChannelsForUser`, **both** branches of `getDefaultChannel`, and `searchAllChannels`. Missing any one puts DMs in the channel sidebar with a null name, redirects `/team` into a DM, or surfaces DM bodies in Cmd-K.
4. **`searchAllChannels` intersects on actual membership.** It previously had an `OR isDefault: true` branch granting search regardless of membership — harmless while "default" implied "everyone", a real leak once visibility became mutable. Migration `20260719120000` backfills an explicit membership row for every user on their default channel so dropping it cost nobody their `#general` results.
5. **`browsePublicChannels` / `getPublicChannelPreview` are metadata-only** — they must never touch `TeamChannelMessage` or project `lastMessagePreview`. They are served to non-members.
6. **`team:dm:created` is id-only.** The recipient refetches the membership-filtered list; the frame itself discloses nothing even if mis-routed. Do not enrich it.
7. **`team:channel:activity` carries no message body.** It fans to the *team* room, which includes non-members of private channels. Any mention toast built on it is necessarily preview-less — that is the design, not an oversight.

---

## 4. Realtime

DMs required **no changes to any existing `team_channel.*` fanout rule** — a DM is a non-default channel, so `emitToChannel` (the `chan:` room, gated by `subscribe:channel`) and `emitChannelScoped` (per-member `user:` rooms, fails closed) already route correctly.

One rule was added: `team_channel.dm_created` emits to the participants' `user:` rooms via `emitToUser`. Chosen over a `team.catalog_changed` tick, which would make every member of the team refetch whenever any two people start a DM.

`team:channel:pin:changed` now carries `pinnedAt` / `pinnedById` / `pinnedByName` (additive) so the pins bar updates from the message the client already holds. It still falls back to refetching `/pins` when the pinned message is off the loaded slice, and the `connect` refetch remains the reconnect convergence path.

---

## 5. Frontend notes

- **The sidebar is sectioned** (Channels / Direct messages) inside one scroller. Channels sort by name (muscle memory); DMs sort by recency. DMs are **not** virtualized — a person has a handful, and virtualizing would push the presence `Set` through a memo boundary that changes identity on every presence frame. Resolve presence to a per-row boolean instead.
- **`ChannelExistenceGuard` must consult BOTH lists.** DMs are excluded from the channel list, so a guard checking only channels concludes every DM was "deleted" the moment it opens and bounces the user to `/team`. (This shipped broken once; only a UI test caught it.)
- **Composer drafts** are keyed `team-chat:<teamId>:draft:<channelId>[:t:<threadRootId>]`. `TeamChatWorkspace` is rendered **without a key**, so the composer is NOT remounted on `/team/A → /team/B` — a mount-only restore would carry A's text into B and overwrite A's draft. One effect keyed on `draftKey` restores on run and writes the *outgoing* value on cleanup, reading from a ref (the cleanup closure captures stale text otherwise).
- **Day separators render inside the virtualized row wrapper**, not as their own virtual items — keeping `count === messages.length` preserves the stable `getItemKey` contract, and `measureElement` absorbs the extra height. Header rows would desync every measured key on an older-page prepend.
- **The unread divider freezes `lastReadAt` on open.** `markRead()` fires on mount, so a live value erases the divider before it paints.
- **`document.title` has exactly one owner per route** — the inbox on `/inbox`, `TeamTitleBadge` on `/team`. Cross-page awareness is the app rail's job, which carries its own server-seeded mention badge (a purely client-derived count has no authoritative seed and no post-offline convergence).
- **Deliberately NOT built:** a pure-reducer table with `assertReducerCoverage`, and a channel LRU message cache. The inbox needs the former because *three* consumers apply each event and a miss is silently stale; team chat has one consumer per event and a miss fails loudly. Channel switching is a route navigation with `<Link>` prefetch + router cache + SSR, not the inbox's in-page swap. Revisit only if a second consumer appears or latency is *measured*.

---

## 6. Testing

`tests/e2e/team-chat/` — `dm-and-visibility.spec.ts` (API-level security invariants: DM dedup, admin-cannot-inject, DM/private leakage into every channel surface, browse/join/preview, 404-not-403) and `ui-smoke.spec.ts` (sectioned sidebar, browse dialog, DM header renders the peer with no channel-admin controls).

Gotchas that cost real debugging time:

- `normalizeChannelName` rewrites every non-`[a-z0-9-]` char to `-`, so seeding a channel named `e2e_foo` stores `e2e-foo`. A cleanup filter on the underscore prefix silently leaks every seeded channel.
- **`waitForLoadState("networkidle")` can never settle here** — team chat holds a persistent Socket.io connection. Wait on elements.
- The DM unique means leftover rows from an aborted run collide on the next one. Clean `kind='dm'` rows between runs.
