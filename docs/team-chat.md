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

1. **`assertNotDm` guards `update` / `remove` / `addMembers` / `removeMember`.** Without it, `POST /api/workspace/channels/:dmId/members` lets an admin inject a third party into two colleagues' private DM — and the existing `members_changed` fanout dutifully wires them into the room with full history. This is the single most important guard added with DMs.
2. **`createOrGetDm`'s target lookup carries `teamId` + `deactivatedAt: null`.** Without `teamId`, a client-supplied foreign userId plants a cross-tenant DM that surfaces in the *other* team's DM list. (`deactivatedAt` matches `addMembers`: you can keep reading an existing DM with someone who left, but you can't start a new one.)
3. **`kind: "channel"` filters** in `listChannelsForUser`, **both** branches of `getDefaultChannel`, and `searchAllChannels`. Missing any one puts DMs in the channel sidebar with a null name, redirects `/team` into a DM, or surfaces DM bodies in Cmd-K.
4. **`searchAllChannels` intersects on actual membership.** It previously had an `OR isDefault: true` branch granting search regardless of membership — harmless while "default" implied "everyone", a real leak once visibility became mutable. Migration `20260719120000` backfills an explicit membership row for every user on their default channel so dropping it cost nobody their `#general` results.
5. **`browsePublicChannels` / `getPublicChannelPreview` are metadata-only** — they must never touch `TeamChannelMessage` or project `lastMessagePreview`. They are served to non-members.
6. **`team:dm:created` carries the channel id and `createdByUserId`, and nothing else.** The recipient refetches the membership-filtered list; the frame itself discloses no content and no membership even if mis-routed. The actor is the one permitted addition — it goes only to the two participants, who already know who they are, and without it the starter's own tab cannot tell its own click apart from a stranger DMing them (see §4). Do not enrich it further: no name, no avatar, no preview.
7. **`team:channel:activity` carries no message body.** It fans to the *team* room, which includes non-members of private channels. Any mention toast built on it is necessarily preview-less — that is the design, not an oversight.
8. **`subscribe:channel` re-checks membership on EVERY subscribe, not only on first join.** Socket.io's `connectionStateRecovery` restores a socket's rooms with no handler running, and `evictUserFromChannelRoom` can only reach sockets that are live at the moment access is revoked. Skipping the check when the socket was "already in the room" meant revoking someone's private-channel access while their laptop slept left them in `chan:<id>` indefinitely, receiving every message. A failed check now **leaves** the room, and `pruneRecoveredChannelRooms()` sweeps restored rooms on `client.recovered`. Residual, inherent to recovery: frames buffered during the ≤30s disconnect window replay before any handler runs — closing that means disabling recovery.
9. **A DM whose peer left the team is read-only, server-side.** `assertChannelWritable` gates all three send paths (`postMessage` / `postThreadReply` / `uploadMedia`) with `dm_peer_deactivated` (422). The composer swap in the UI is the affordance; this is the rule. A self-DM has no peer row, so notes-to-self stays writable — don't "simplify" the check into a member-count test.
10. **Mention counters compare `COALESCE(editedAt, createdAt)` against the read receipt.** An edit is the only way to be mentioned without a new message, and by then the message's `createdAt` is already behind the reader's receipt — comparing `createdAt` alone dropped the mention silently and permanently. `team_channel.message_edited` carries `newlyMentionedUserIds` so the fanout badges exactly those people (re-badging everyone on a typo fix would resurrect cleared mentions).
11. **Reaction `emoji` must actually be an emoji.** A byte cap alone let any short string become a permanent chip rendered under the message for every member, one row per distinct value, with no bulk removal. Validated by an emoji-only class **plus** a non-ASCII requirement (keycap sequences are built on ASCII digits), and capped at `MAX_DISTINCT_REACTIONS_PER_MESSAGE` per message.

---

## 4. Realtime

DMs required **no changes to any existing `team_channel.*` fanout rule** — a DM is a non-default channel, so `emitToChannel` (the `chan:` room, gated by `subscribe:channel`) and `emitChannelScoped` (per-member `user:` rooms, fails closed) already route correctly.

One rule was added: `team_channel.dm_created` emits to the participants' `user:` rooms via `emitToUser`. Chosen over a `team.catalog_changed` tick, which would make every member of the team refetch whenever any two people start a DM.

It carries `createdByUserId`, and **creating a DM raises no toast or sound for anyone**. Two reasons, both learned the hard way: the frame reaches BOTH participants with no author to filter on, so the starter's own tab alerted them about their own click — and a client-side "I just did this" marker stamped when the POST resolves always loses the race against the socket frame, so the actor has to ride on the payload. Separately, an *empty* DM is not news: the peer's sidebar already grows the row from this same frame, and the first real message alerts through `team:channel:activity`. The provider still subscribes, silently, to register the id as a DM — see the frontend note below.

`team:channel:pin:changed` now carries `pinnedAt` / `pinnedById` / `pinnedByName` (additive) so the pins bar updates from the message the client already holds. It still falls back to refetching `/pins` when the pinned message is off the loaded slice, and the `connect` refetch remains the reconnect convergence path.

---

## 5. Frontend notes

- **The sidebar is sectioned** (Channels / Direct messages) inside one scroller. Channels sort by name (muscle memory); DMs sort by recency. DMs are **not** virtualized — a person has a handful, and virtualizing would push the presence `Set` through a memo boundary that changes identity on every presence frame. Resolve presence to a per-row boolean instead.
- **`ChannelExistenceGuard` must consult BOTH lists.** DMs are excluded from the channel list, so a guard checking only channels concludes every DM was "deleted" the moment it opens and bounces the user to `/team`. (This shipped broken once; only a UI test caught it.)
- **`TeamChatWorkspace` and `ChannelComposer` are rendered WITHOUT a key — they do NOT remount on `/team/A → /team/B`.** Treat every `useState` in that subtree as leaking across channels until proven otherwise; per-channel state needs an explicit reset in an effect on `initialChannel.id`. This has bitten six separate pieces of state, the worst by far a **staged file attachment**, which stayed in the composer across the switch so the next Send uploaded a private file into the wrong conversation. Also: member count (froze on the first channel viewed, forever), in-channel search (stayed open, pre-filled, silently re-running the old query), pinned-bar expansion (a 1-pin channel's expanded bar carried into a 14-pin one and swallowed the feed — fixed by keying `<PinnedBar>` on the channel id), the thread panel, and the search-jump highlight. Watch effect ORDER when adding one: a bare `[initialChannel.id]` reset runs right after the `?q=` reader on MOUNT and wipes what it just set — guard on an actual id change via a ref.
- **Composer drafts** are keyed `team-chat:<teamId>:draft:<channelId>[:t:<threadRootId>]`. One effect keyed on `draftKey` restores on run and writes the *outgoing* value on cleanup, reading from a ref (the cleanup closure captures stale text otherwise). Drafts are text-only by design; a staged file has nowhere to be saved, so it is dropped on switch rather than carried.
- **`clientTempId` is NOT a "this frame is mine" marker.** The server echoes it on the `team:channel:message` frame sent to the WHOLE `chan:` room, so every recipient sees it truthy for anything composed in the web app. Ownership is `authorUserId`. Testing the tempId alone let teammates' live messages append straight into an anchored (search-jump) slice under a three-month-old day separator, while the Jump-to-live pill showed no count.
- **`dmChannelIds` on `TeamChatNotificationsProvider` must be a LIVE set, not the layout's snapshot.** The `(app)` layout is a shared segment that doesn't re-render on client navigation, so a DM created after page load was never in the set and every message in it went unalerted for the rest of the session. Kept in a ref and grown from `team:dm:created`.
- **`getChannelById` server-resolves `peer` for DMs.** The client-side DM list is a layout-level snapshot, so a just-created DM painted a blank avatar titled "Direct message" until a refetch landed — and stayed wrong if that fetch failed. The live list still wins (it tracks renames/avatars); the DTO is the first-paint fallback. The route's `<h1>` is emitted by the workspace for DMs for the same reason: the server component only sees `channel.name`, which is null, so every DM announced the identical heading to screen readers.
- **Message-row typography is load-bearing.** A block's line boxes are floored by its OWN strut, so setting a size on the inline `<span>` alone does nothing: an `opacity-0` hover timestamp in the grouped-row gutter wrapped to two 24px lines and made every grouped row 54px instead of 27. And the wrap utility is `wrap-break-word` (**singular**) — the plural spelling is not a Tailwind v4 utility, emitted no CSS, and long pasted URLs ran straight out of the column.
- **Virtualized rows can't inherit the container's padding.** `left-0` / `w-full` on an absolutely-positioned row resolve against the containing block's *padding box*, so `px-2` on the react-virtual spacer was silently dropped and the active channel row ran flush into the app rail while the (non-virtualized) DM rows stayed inset. Padding belongs on the row.
- **Day separators render inside the virtualized row wrapper**, not as their own virtual items — keeping `count === messages.length` preserves the stable `getItemKey` contract, and `measureElement` absorbs the extra height. Header rows would desync every measured key on an older-page prepend.
- **The unread divider freezes `lastReadAt` on open.** `markRead()` fires on mount, so a live value erases the divider before it paints.
- **`document.title` has exactly one owner per route** — the inbox on `/inbox`, `TeamTitleBadge` on `/team`. Cross-page awareness is the app rail's job, which carries its own server-seeded mention badge (a purely client-derived count has no authoritative seed and no post-offline convergence).
- **Deliberately NOT built:** a pure-reducer table with `assertReducerCoverage`, and a channel LRU message cache. The inbox needs the former because *three* consumers apply each event and a miss is silently stale; team chat has one consumer per event and a miss fails loudly. Channel switching is a route navigation with `<Link>` prefetch + router cache + SSR, not the inbox's in-page swap — which is exactly why it needs a `loading.tsx` (the route is dynamic: three server fetches before it can stream, and without a boundary the router held the PREVIOUS channel on screen for the whole round-trip) and an optimistic `pendingChannelId` in the sidebar (the selected row otherwise only moves once the server responds, so a click read as "nothing happened, then everything jumped"). Revisit only if a second consumer appears or latency is *measured*.

---

## 6. Testing

`tests/e2e/team-chat/` — `dm-and-visibility.spec.ts` (API-level security invariants: DM dedup, admin-cannot-inject, DM/private leakage into every channel surface, browse/join/preview, 404-not-403), `ui-smoke.spec.ts` (sectioned sidebar, browse dialog, DM header renders the peer with no channel-admin controls), and `ui-polish.spec.ts` — the regression gate for the invariants above. It **measures the rendered DOM** rather than asserting on class names, deliberately: every defect it covers shipped with class names that looked correct while the layout was wrong. Row heights, popover rects vs their clipping ancestor, sidebar insets, `overflow-wrap`, plus the server-side rules (`dm_peer_deactivated`, non-emoji reactions, `?take=abc` → 400 not 500).

`tests/e2e/post-audit-fixes/emoji-popover-placement.spec.ts` guards the inbox: `EmojiPopover` is shared with the reply box and gained an auto-flip for clipped scrollers, which must NOT fire where there's room above.

Gotchas that cost real debugging time:

- `normalizeChannelName` rewrites every non-`[a-z0-9-]` char to `-`, so seeding a channel named `e2e_foo` stores `e2e-foo`. A cleanup filter on the underscore prefix silently leaks every seeded channel.
- **`waitForLoadState("networkidle")` can never settle here** — team chat holds a persistent Socket.io connection. Wait on elements.
- The DM unique means leftover rows from an aborted run collide on the next one. Clean `kind='dm'` rows between runs.
- **The composer ignores Enter while a previous send is in flight.** A test that fills-and-Enters twice in a row silently drops the second message. Wait for the box to clear.
