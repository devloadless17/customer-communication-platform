# WhatsApp messaging limits, throughput & tiers — verified values

**Verified against Meta's live documentation on 2026-07-18.**

This file exists because the tier ladder, throughput figures and error handling in
our code were originally written from memory rather than from Meta, and had gone
stale — `docs/Meta/whatsapp.md` links out to Meta but does not carry the numbers,
so nothing in the repo pinned them. One of the resulting defects was live (see
"Defects this pass found" below).

**Re-verify this file whenever a broadcast sizing/pacing decision depends on it.**
Meta changed this ladder as recently as 2025-10-07.

Sources:
- [Messaging Limits](https://developers.facebook.com/docs/whatsapp/messaging-limits/)
- [Upcoming changes to messaging limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/upcoming-messaging-limits-changes/)
- [Throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput)

---

## Messaging limits (the pre-send eligibility gate)

A messaging limit is **the maximum number of unique WhatsApp user phone numbers a
business can deliver messages to, outside of a customer service window, within a
moving 24-hour period.**

Three properties matter for our gate, and all three are easy to get wrong:

| Property | Value | Consequence for us |
|---|---|---|
| Window | **Moving (rolling) 24h**, not calendar day | A send at 23:00 still occupies budget at 09:00 the next day. Our counter uses a rolling window. |
| Scope | **Per business portfolio**, shared by every phone number in it (since 2025-10-07) | We store the cap per-team on `ChannelConnection`. Correct for one-number-per-team; **optimistic** for a customer with several numbers in one portfolio. |
| Counts | Unique recipients messaged **outside** a customer service window | Free-form replies inside the 24h service window do **not** consume budget. Template/business-initiated sends do. |

### The tier ladder (current, post 2025-10-07)

| Tier | Cap (unique recipients / rolling 24h) |
|---|---|
| `TIER_250` | 250 — the starting limit for a new portfolio |
| `TIER_2K` | 2,000 |
| `TIER_10K` | 10,000 |
| `TIER_100K` | 100,000 |
| `UNLIMITED` | no cap |

Changes that landed **2025-10-07**:
- Limits moved from **per phone number** to **per business portfolio**.
- The auto-scaling threshold moved **1,000 → 2,000**, so **`TIER_1K` is no longer
  a tier a number can currently sit at.** We keep it in the map anyway so a
  snapshot taken before the change still sizes at 1,000 rather than normalizing
  to `null` and going ungated.
- Auto-scale upgrades now land within **~6 hours** (was 24).
- A newly registered number inherits its portfolio's limit (previously started at 250).
- The **`FLAGGED` phone-number quality state no longer exists**, and a quality
  drop **no longer downgrades a messaging limit**. Quality still matters for
  reputation; it is no longer a mechanism that shrinks the cap mid-campaign.
- New field `whatsapp_business_manager_messaging_limit` returns the portfolio
  limit (e.g. `TIER_250`).

## Throughput (send pacing)

| Level | Rate |
|---|---|
| Default | **80 messages/second** |
| Upgraded | **1,000 messages/second** (automatic for eligible accounts) |
| WhatsApp Business **app** number used with Cloud API simultaneously | **20 mps** (fixed) |

- Throughput is **per registered business phone number** (unlike messaging
  limits, which are per portfolio). Read via
  `GET /<PHONE_NUMBER_ID>?fields=throughput`.
- It is **inclusive of inbound and outbound** messages — the ceiling is not an
  outbound-only send budget.
- Eligibility for 1,000 mps now requires the **portfolio** to hold an unlimited
  messaging limit *and* the number to message 100K+ unique users in 24h.
- Meta's docs express throughput as numeric mps. Our code normalizes to
  `STANDARD` / `HIGH` (the values the API has historically returned in the
  `throughput.level` field); the 80 / 1,000 figures above are what those map to.

**Our pacing deliberately runs far below these ceilings** — see the measured-vs-
claimed table in `resolveSendPacing` (`apps/api/src/lib/broadcast-runner.ts`).
A 100k send takes 1–3 hours in practice. Being well under the ceiling is what
protects the number's quality rating.

---

## Defects this pass found

1. **`TIER_2K` was absent from the tier map**, and the shorthand parser's regex
   was anchored without the `TIER_` prefix, so `normalizeMessagingTier("TIER_2K")`
   returned `null`. A number on Meta's *second* tier was therefore recorded as
   "unknown tier" and left **completely ungated** — a 100k campaign on a 2k number
   would pass the pre-send check and burn ~98k recipients on guaranteed failures.
2. **A bare cap of `2000` bucketed into `TIER_10K`** — a 5× over-estimate, because
   the ladder had a 1,000 bucket and nothing at 2,000.

Both are fixed and pinned by
`tests/e2e/meta-channels/meta-messaging-tiers.spec.ts`.

## Known remaining gap

Our budget counter is **per-team/per-number**, but Meta's limit is **per
portfolio**. For a customer running multiple numbers inside one portfolio, our
remaining-budget figure is optimistic — the other numbers' spend is invisible to
us. Meta still enforces the true limit, so the failure mode is a rejected send
rather than an overcharge. Closing this means reading
`whatsapp_business_manager_messaging_limit` at portfolio scope and tracking usage
per portfolio instead of per connection.
