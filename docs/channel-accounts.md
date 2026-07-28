# Channel accounts — several numbers, Pages and handles in one workspace

How a workspace holds **more than one account on the same channel**, how the
three Meta channels share one Meta app, and what an agent sees in the inbox.

Related: [adding-a-channel.md](adding-a-channel.md) ·
[meta-manual-onboarding.md](meta-manual-onboarding.md) ·
[campaign-analytics.md](campaign-analytics.md) ·
[workspaces.md](workspaces.md)

---

## 1. The hierarchy

```
Organization
└── Workspace                       ← the data-isolation boundary
    ├── MetaConnection              ← ONE per workspace: the shared Meta app
    │                                 (appId, appSecret, system-user token)
    └── ChannelConnection[]         ← ONE PER ACCOUNT
        ├── whatsapp   · +1 555 010 0000   (phoneNumberId)   → WABA → Portfolio
        ├── whatsapp   · +44 20 7946 0000  (phoneNumberId)   → WABA → Portfolio
        ├── messenger  · Acme Store        (pageId)
        └── instagram  · @acme             (igId)
```

`ChannelConnection` is the per-account row — there is no second table.
`@@unique([workspaceId, channel, externalAccountId])` is what makes multiplicity
possible; `externalAccountId` is the provider's own id (WhatsApp
`phoneNumberId`, Messenger `pageId`, Instagram `igId`), promoted to a top-level
indexed column so an inbound webhook resolves its account in one indexed lookup.

**There is no `provider`/`vendor` column.** WhatsApp, Messenger and Instagram
are three *channels* that happen to share one vendor — see CLAUDE.md §5.

### WhatsApp's extra two levels

WhatsApp is the only channel with structure above the account, and the two
levels scope different things:

| Level | Scopes | Modelled as |
|---|---|---|
| **Business portfolio** | the 24h **messaging limit** (since 2025-10-07, shared by every number in it) and the **template limit** (250 unverified / up to 6,000 verified, per WABA) | `WhatsappPortfolio` |
| **WABA** | the **template catalog** — numbers under one WABA share templates | `ChannelConnection.wabaId`, `MessageTemplate.wabaId` |
| **Phone number** | **quality rating**, **throughput level**, the 24h window, threading | `ChannelConnection` |

So two numbers in one portfolio **share a daily budget** and, if they are under
one WABA, **share a template catalog** — but each keeps its own quality rating
and throughput. The messaging-health panel says so explicitly ("shared across 2
numbers in the same business portfolio") because otherwise a remaining-budget
figure is misleading.

The template limit is derived from `WhatsappPortfolio.verificationStatus`
(`portfolioTemplateLimit`). Meta's verified ceiling additionally requires one
WABA in the portfolio to have a number with an approved display name — not
readable from any node we already fetch, so the figure is presented as an upper
bound and never used as a gate. Meta rejects at the real limit.

---

## 2. One Meta app, three channels

`MetaConnection` holds the app-level credentials **once per workspace**
(`appId`, `appSecret`, system-user token). All three Meta channels read it, and
`/settings/meta` is where it is set — the channels catalog blocks with "Set up
your Meta App first" until it is.

Per-account credentials (the access token for that number/Page/handle) live on
the account's own `ChannelConnection.secrets`, envelope-encrypted.

**Webhooks stay per-workspace, not per-account:** `/webhooks/meta/:workspaceId`.
The HMAC is verified against the workspace's `appSecret`, then the account is
resolved *from the payload* — `entry[].changes[].value.metadata.phone_number_id`
for WhatsApp, `entry[].id` (Page id / IG account id) for the social channels. An
`entry` naming an account this workspace hasn't connected is dropped fail-soft
(`{dropped: "unknown_account"}`), never ingested.

### Messenger and Instagram on the same Facebook Page

They are **two accounts, not one**, because they key on different ids:

- Messenger's `externalAccountId` is the **Page id**.
- Instagram's is the **IG professional account id**, which is a different value
  even when that IG account is linked to the same Page.

Meta delivers them as different webhook `object` types (`page` vs `instagram`),
which `channelForMetaObject` maps to the channel before account resolution. The
`@@unique` is on `(workspaceId, channel, externalAccountId)`, so nothing
collides even if the two ids were ever equal.

---

## 3. Which account a reply goes out on

`Conversation.channelConnectionId` records the account a thread is on. It is
stamped at ingest and **re-stamped on every inbound**: Meta's thread affinity
and the 24h window belong to the *number the customer last messaged*, so a reply
always goes back out that way. (This is deliberately different from
`webchatWidgetId`, which is sticky.)

`resolveSendAccount(conversation)` **refuses to guess** — an unbound thread
throws `send_account_unresolved` rather than falling back to a sibling number,
because replying from a number the customer never messaged is worse than a
visible error. Compose-new **binds** the account at creation — explicit if the caller names one
(validated against this workspace *and* channel), else the channel default. It
used to leave `channelConnectionId` null, which still SENT (the send config falls
back to the default) but left the thread unattributed in the inbox, invisible to
the account filter, and liable to migrate silently the day the default changed.

Broadcasts carry `Broadcast.channelConnectionId`, and the pre-send eligibility
gate reads **that account's** portfolio budget. Passing only the workspace
measured the channel default's portfolio instead — so a campaign from the second
number was checked against a budget it does not draw on.

Disconnecting an account deletes the row (its credentials are what is being
revoked) and `Conversation.channelConnectionId` is `SetNull`: history survives,
those threads become unsendable until reconnected, and they are **not** silently
moved to another number.

---

## 4. What people see

| Surface | Shows |
|---|---|
| `/settings/channels` | per-channel account counts — "2 numbers connected" |
| `/settings/{whatsapp,messenger,instagram}` | `ChannelAccountsPanel`: every account with its own quality / throughput / last sync, **grouped by portfolio**; label, default, reconnect state; **"Add another"** opens the connect form |
| Inbox list row | a chip with the account name — **only when the channel has >1 account** |
| Inbox thread header | `+1 555… · via Sales line` — who you are replying *as* |
| Inbox sub-sidebar | an **Accounts** picker to narrow the list to one number |
| `/v1` | `GET /channel-accounts`; `GET /conversations?accountId=…`; `channelConnectionId` on every conversation |

### Why the health figures are split the way they are

Quality and throughput are per **number**; the 24h budget and the template limit
are per **portfolio** and shared. So the panel renders quality/throughput on each
account row, and states the budget **once per portfolio group** with "shared by N
numbers" spelled out. Printing "10,000 / 24h" under each of two numbers reads as
20,000 and invites a campaign Meta refuses halfway through — the single most
expensive misreading this screen could produce.

### The inbox stays UNIFIED

Multi-account does not mean switching inboxes. Every account's conversations sit
in one list, each row labelled with the account it arrived on; the Accounts
picker narrows on demand. Three deliberate properties:

- **Orthogonal to the preset/stage/view selection.** Those are an exclusive
  union (`Filter`) — picking a stage clears the preset. The account narrow is a
  SECOND dimension, because "Unassigned" and "on the Sales number" are different
  questions and an agent wants both. It is ANDed server-side as its own
  independent clause, never merged into the filter object.
- **Not persisted.** Unlike the preset, which is remembered in a cookie. A
  remembered account narrow is a silent trap: the agent returns to an inbox
  missing every conversation on the other numbers with nothing on screen
  explaining why. "All accounts" is the honest state to land on each session.
- **Self-hiding** below two accounts on a channel — the same rule as the row
  chip. A one-entry filter is clutter.

Wired through `filterKey` in `use-team-events.ts`. That key is the ONLY refetch
trigger: leaving the account out of it made the picker light up and change
nothing. Covered end-to-end by `tests/e2e/inbox-multi-account.spec.ts`.

Attribution is conditional on purpose. Rendering the number on every row in a
one-number workspace is noise; it is a disambiguator, so it appears exactly when
there is something to disambiguate (`showAccountFor` in
`channel-accounts-context.tsx`).

The agent-facing read is `GET /api/workspace/channel-accounts` — display fields
only (id, channel, name, provider name, default/active). It is deliberately
**separate** from the admin management endpoints under
`/api/workspace/channels/:channel/accounts`, which decrypt and mutate
credentials and are `@RequireRole("admin")`. The directory is SSR-seeded once in
the inbox layout and joined client-side against
`Conversation.channelConnectionId`, rather than widening every list row with a
relation — the inbox list is the hottest read in the app and a workspace has a
handful of accounts.

### Adding an account

There is no separate "add account" form: the channel's normal connect form
**upserts on the provider's account id**, so pasting a second number's
credentials creates a second account rather than overwriting the first. The
"Add another" button just reveals that form and says what it will do.

`normalizeDefaultAccount` runs on every connect. It deletes the credential-less
`externalAccountId: ""` placeholder that `getConfig` pre-mints on a settings-page
load, and guarantees exactly one *active* default — without it the placeholder
stayed `isDefault: true` and every webhook resolved to a row with no appSecret,
silently dropping all inbound.

---

## 5. Embedded Signup readiness

Nothing here needs to change for WhatsApp Embedded Signup
([onboarding-future.md](onboarding-future.md)). ES returns exactly the values
this model already keys on — `waba_id` and `phone_number_id`, plus a code
exchanged for a token — and a business that onboards several numbers produces
several `phone_number_id`s. That is N calls to the same `updateConfig` upsert
path the manual paste uses today, so ES replaces the *credential-entry UI* and
touches no routing, ingest or send code.

---

## 6. Invariants

- **`@@unique([workspaceId, channel, externalAccountId])`** — one row per
  account. Re-connecting the same number updates rather than duplicates.
- **Dedup keys stay workspace-scoped**, NOT per-account:
  `@@unique([workspaceId, channel, externalId])` on `Message`/`Call`. A wamid is
  already unique; adding the account would make status webhooks miss.
- **Sends never guess an account** — `resolveSendAccount` throws.
- **The account is re-stamped on every inbound**; the widget binding is sticky.
- **No credentials in the member-readable directory** — display fields only.
- **Attribution renders only above one account per channel** — otherwise the
  single-account inbox must look byte-identical to before.
- **The broadcast gate reads the SENDING account's portfolio**, never the
  channel default's.
- **The account narrow is ANDed, never merged**, and must be part of
  `filterKey` or it silently does nothing.
- **`business_management` is required in practice.** Meta lists it optional; it
  is what resolves the portfolio, so without it the shared budget and the
  template limit are blank and broadcasts send ungated. Both onboarding guides
  say so, and the panel says how to fix it.
