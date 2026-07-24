# Campaign analytics & send rate

> Two sources of truth about a campaign, reported **side by side and never
> merged**. Plus the per-number ceiling that keeps a blast from costing you the
> number's quality rating.

---

## 1. Why there are two sources

| | What it is | The only source of |
|---|---|---|
| **Delivery funnel** | per-recipient truth, built from Meta's status webhooks | `replied`, opt-outs, per-recipient failure reasons |
| **Meta analytics** | Meta's own aggregate, per template per day | real currency **cost**, unique **URL-button clicks** |

They measure different things and **will not agree**. A template used by two
campaigns on the same day contributes both campaigns' volume to Meta's figures,
while the funnel is scoped strictly to one campaign. Blending them would produce
a number matching neither source — and one whose meaning silently changes as
Meta's 7-day window expires. So the UI renders them as two panels, and the API
returns them as two blocks (`funnel` and `metaAnalytics`).

## 2. The null rules — the part that is easy to get wrong

Meta reports **read** and **clicked** for roughly the last 7 days only, and
withholds **cost** entirely when the WABA is billed through a Solution Partner.

Three rules follow, and all three are load-bearing:

1. **A missing metric is `null`, never `0`.** "We don't know" and "nobody read
   it" are different answers. The parser (`parseTemplateAnalytics`) maps an
   absent field to null and preserves a reported `0` as zero.
2. **A later null never overwrites a captured value.** Re-fetching a three-week
   old campaign legitimately returns nulls for numbers we captured correctly at
   the time. The rollup is therefore written with a raw
   `ON CONFLICT … COALESCE(EXCLUDED.x, t.x)` upsert. A naive Prisma upsert would
   zero out good history on every refresh — permanently, because the source can
   no longer produce those numbers.
3. **A total stays null when no day reported it.** Summing nullable metrics
   skips nulls, but if *every* day is null the total is null rather than 0.

Every one of these is pinned in `apps/api/test/template-analytics.spec.ts`.

The UI carries this through: a null renders its **reason** ("Meta reports reads
for 7 days only"), never a bare dash. An unexplained "—" is what makes people
assume the feature is broken.

## 3. Enabling it is irreversible

Meta requires a one-time `is_enabled_for_insights=true` per WABA before it
reports anything, and there is **no way to undo it**. So:

- it is its own endpoint, never a side effect of a read;
- it is not exposed on `/v1` at all — only an in-app admin action;
- it refuses when already enabled, and stamps `insightsEnabledAt` so the UI
  offers it exactly once and every later "why is there no data before March" has
  a dated answer.

## 4. Cadence — why refresh is manual

The campaign report is polled every few seconds while a send runs. A Graph call
on that path would mean thousands of requests per campaign and would exhaust
Meta's rate limit — for an aggregate that barely moves minute to minute.

So `POST /broadcasts/:id/analytics/refresh` is an explicit action, it stores
into the rollup, and the report always reads the **stored** rollup. The report
itself never makes a network hop.

## 5. The delivery curve

Meta's analytics are **daily**. A campaign that finishes in twenty minutes is
one point on a daily series, which says nothing about how it went. The curve is
therefore built from `BroadcastRecipient` timestamps.

Two decisions worth knowing:

- **Each event buckets by its OWN timestamp.** The tempting shortcut — group by
  the send bucket and `FILTER (WHERE "deliveredAt" IS NOT NULL)` — answers "of
  the messages sent this minute, how many were *ever* delivered", so the
  delivery curve would trace the send curve's shape and a slow carrier would be
  invisible. What a reader wants is "how many had been delivered *by* this
  minute". Hence the `UNION ALL` of four event streams.
- **Bounded output.** The server picks a bucket width from the span (snapped to
  a human unit), targeting ~120 points. A 100k campaign returns the same few
  hundred points a 100-recipient one does, so payload and render cost scale with
  the *span*, not the audience.

Backed by `@@index([broadcastId, deliveredAt])` and `([broadcastId, readAt])` —
scoped to exactly those two curves, because this table takes a write on every
status webhook and each index is paid on every one of them.

## 6. The per-number send-rate bucket

`apps/api/src/lib/broadcasts/send-rate-limiter.ts`. **Dark by default**
(`BROADCAST_RATE_LIMITER_ENABLED=1` to turn on).

The runner paces sends with a fixed per-lane sleep. That approximates a rate but
cannot enforce one: the real period is `work + gap`, so the rate drifts with
Meta's latency — and the sleep is per-process and per-run, so two campaigns on
one number each pace themselves to the target and together sail past it. Meta's
ceiling is per NUMBER and counts inbound too.

A Redis token bucket keyed on the `phoneNumberId` is the only place that can be
true regardless of how many runs, lanes or processes exist.

| Throughput | Target | Meta's ceiling |
|---|---|---|
| `HIGH` | 900 msg/s | ~1000 |
| `STANDARD` | 75 msg/s | 80 |
| unknown | 40 msg/s | — |

The gap below the ceiling is **deliberate inbound headroom**: the ceiling counts
inbound too, so saturating it starves the inbox exactly when customers are
replying to the campaign. Unknown throughput assumes the slower tier — being
wrong that way costs time; the other way costs the number's quality rating.

Implementation notes: the refill-and-take is **Lua** so it is atomic (a GET/SET
version lets two lanes take the same token), it reads `redis.TIME` rather than a
client clock so the api and a future worker container can't disagree about
"now", negative elapsed (an NTP step) is clamped to zero rather than draining
the bucket, and it **fails open** if Redis is unreachable — a limiter that halts
an already-paid-for campaign because a cache is down has done more damage than
the overshoot it prevented.

## 6a-bis. Where the tier actually comes from

The messaging limit is the maximum number of unique users you can message
*outside a customer-service window* in a moving 24h — and since **2025-10-07 it
is PORTFOLIO-scoped**: every number in a portfolio shares one allowance, so one
number can consume all of it. That is why `messagingTier` /
`messagingDailyCap` live on `WhatsappPortfolio` and not on the connection; a
per-number write would record one portfolio's budget N times.

Meta spells the same ladder four different ways, and the two we used to read are
gone or going:

| Source | Field | Status |
|---|---|---|
| phone-number / WABA / portfolio node | `whatsapp_business_manager_messaging_limit` | **current** |
| phone-number node | `messaging_limit_tier` | **deprecated** |
| `business_capability_update` · `phone_number_quality_update` | `max_daily_conversations_per_business` | **current** (on both) |
| `business_capability_update` | `max_daily_conversation_per_phone` | **removed Feb 2026** |
| `phone_number_quality_update` | `current_limit` | limit meaning **removed Feb 2026**; now also carries the number's *throughput* level |

`normalizeMessagingTier` is the single funnel for all of them, and it returns
**null for anything it doesn't recognise** — deliberately. A throughput string
(`STANDARD` / `HIGH`) now shares the `current_limit` field, and mapping one onto
a tier would gate a campaign against a number that means nothing. Null = ungated,
which is the safe direction here because the *rate* limiter still applies.

> **The trap.** Both the poll and the webhook read a field, get nothing, and
> store null — no error anywhere. The number then looks ungated and the 24h
> budget gate stops protecting it. That is why the poll asks for the current
> field **and** the deprecated one, and why the webhook prefers
> `max_daily_conversations_per_business` and still falls back to both legacy
> spellings.

Related: the ladder starts at 250 and climbs 2K → 10K → 100K → Unlimited.
Reaching 2K needs a scaling path (business verification, partner verification, or
2,000 delivered out-of-window messages to unique users in 30 days on
high-quality templates); after that Meta auto-scales one level per 6h when you
use at least half your current limit with high-quality messaging. A quality drop
no longer downgrades a limit, and the **Flagged** number state no longer exists.

## 6b. Serving every Meta tier in ONE process

Meta auto-scales a healthy number **250 → 2K → 10K → 100K** within weeks, and the
throughput level moves STANDARD → HIGH with it. The send path follows that
automatically — no second container, no redeploy.

**Lanes are derived, not hardcoded.** Little's Law: `concurrency = rate × latency`.

| Tier / throughput | Target rate | Lanes (at ~250ms RTT) |
|---|---|---|
| HIGH (10K/100K) | 900 msg/s | ~225 |
| STANDARD (250/2K) | 75 msg/s | ~19 |
| unknown | 40 msg/s | ~10 |

The old fixed **16 lanes** topped out near 60 msg/s *whatever tier the number
reached* — a number Meta had scaled to 100K would never have used its allowance.

**Why ~225 concurrent is safe in the API process:** these are I/O waits, not CPU.
Each send spends ~250ms in a Meta round-trip and only a few ms touching the DB,
so the 50-slot Prisma pool sees a handful in use, never 225.

**Three independent limits, each with one job:**

1. **Token bucket** (per NUMBER) — the *rate* authority. Targets sit deliberately
   under Meta's published ceilings (75 vs 80, 900 vs 1000) because those ceilings
   count **inbound too**; saturating one starves the inbox exactly when customers
   are replying to the campaign.
2. **Global in-flight ceiling** (per PROCESS, default 300) — bounds total
   concurrent sends across every running broadcast. `MAX_RUNNING_BROADCASTS` caps
   how many campaigns run and the per-team cap caps one tenant's share, but
   neither bounds the *sum*: 6 broadcasts × 225 lanes would be ~1,350 simultaneous
   calls in the process that also serves the inbox. This is what protects
   interactive latency.
3. **Per-team cap** — fairness, so one tenant can't monopolise the global pool. It
   now **scales with the tier**; a fixed 16 would have silently pinned a HIGH
   number back to the old ceiling (`effective = min(lanes, cap)`).

**A 100k broadcast is never loaded whole.** Recipients are keyset-paged
(`PAGE_SIZE`, refilled continuously as lanes drain it), so memory is bounded by
the page, not the audience. The page scales with the lane count — at 225 lanes a
100-row page would drain instantly and leave every lane blocked on the same DB
round-trip.

**The rate limiter is ON by default** (`BROADCAST_RATE_LIMITER_ENABLED=0` to opt
out). It is the authority the lane sizing depends on, and it can only slow
sending, never break it — a Redis outage fails open and every wait is bounded.

## 7. Messaging health

`GET /api/broadcasts/messaging-health` (and `/v1/whatsapp/health`) is one shared
domain function, `getMessagingHealthSummary`. Three surfaces read it — the
broadcast composer's pre-send warning, the WhatsApp settings panel, and `/v1` —
and parity is only real because they share an implementation. The local copy
this replaced counted recent recipients *without* the portfolio scope, so on a
workspace with two portfolios the composer said there was budget while the
runner refused the send.

**The 24h cap is PORTFOLIO-scoped** since Meta's 2025-10-07 change: it is shared
by every number in the business portfolio, which is why `WhatsappPortfolio`
exists and why the panel says "shared across N numbers" when it is.

## 8. The capture sweeper

`lib/sweepers/template-analytics-capture.ts`, every 6h.

Unlike every other sweeper in this codebase, **missing a tick loses data
permanently**. Everything else it could sweep — funnels, failures, cost — can be
re-derived or re-fetched later. Read and click cannot: once Meta's ~7-day window
closes, those numbers are gone from every source we have.

So campaigns that completed within **6** days get re-fetched (a full day of
margin, and at a 6-hourly cadence a campaign gets several chances before the
window shuts). One Graph call per workspace, not per campaign — Meta takes 10
template ids at a time and reports by day anyway. Only workspaces that actually
enabled insights are swept, so an opted-out tenant isn't a guaranteed error
every tick.

## 9. Not built yet — and why Phase 3 is deliberately deferred

**The dedicated broadcast worker container is NOT built, on purpose.** Its own
plan gates it "behind Stage-1 bucket validation", and the bucket is still dark —
it has never run under a real campaign. CLAUDE.md §16 names the trigger
independently: *10k+ recipient broadcasts → move the runner to a dedicated
worker*, and *don't pre-build any of it*.

Building it now would add a second container, a cross-process event bridge, a
heartbeat and a drift sweeper to serve a rate nobody has measured yet. The
correct order is: turn the bucket on for one real campaign, measure the achieved
msg/s and the inbox headroom, and only then move the runner out.

What already anticipates it, so the move is additive rather than a rewrite: the
bucket is keyed per NUMBER (not per run or process), it reads `redis.TIME` so
two processes can't disagree about now, and the outbox already makes the event
path crash-safe.

Also open: a per-template insights **page** (the drawer panel covers the
question today; a standalone page is only worth it if someone wants to compare
templates side by side).

---

## Held for quality assessment (two kinds of pacing)

Meta batches template delivery for portfolios that have sent **under 500k
template messages in a rolling 365 days**, and for any portfolio under review for
suspicious activity. An initial set goes out normally; the rest are **held**,
released batch by batch as feedback comes in — or **dropped** entirely if the
review turns up a problem.

**There are two pacing mechanisms and they are easy to conflate.** Both hold
messages the same way, and both are reported through the same `held` state — but
they have different scopes, different triggers, and *different drop codes*:

| | **Template pacing** | **Business-portfolio pacing** |
|---|---|---|
| Scope | one template | every number in the portfolio |
| Applies to | marketing + utility templates that are new, just-unpaused, or not `GREEN` | portfolios under 500k template sends in a rolling 365d, or under review |
| Bad signal → | that template is **PAUSED**, held messages dropped | held messages dropped, portfolio blocked from sending **and creating** templates |
| Drop code | **132015** (`template_unavailable`) | **135000** (`portfolio_paced_drop`) |
| Good signal → | released and scaled to the whole audience | released batch by batch |

Utility templates are paced only once you have *had* a utility template paused,
and then for 7 days. Meta also guarantees a decision inside a bounded window —
the stated goal is that even a paced high-throughput campaign delivers within an
hour at p99 — and if that guardrail is hit before the feedback is conclusive, the
held messages are simply released.

**The only signal is on the send response**: `message_status:
"held_for_quality_assessment"`, alongside a perfectly normal message id. Ignore
it and the campaign reports as fully sent while most of it sits in Meta's queue —
the same silent over-count that `undelivered` was added to fix.

So:

- `SendTextResult.heldForQualityAssessment` carries it out of the provider;
- the runner seeds `deliveryState: "held"` instead of `sent`;
- `held` ranks **alongside** `sent` in `DELIVERY_RANK`, not below it. A held
  message has already been accepted, so `delivered`/`read` and a terminal failure
  still advance past it, while a plain `sent` webhook can't erase the more
  specific fact;
- the funnel counts `held` inside `accepted` (Meta did take the message) and
  surfaces it as its own row — a campaign that looks stalled needs explaining,
  not discovering;
- a **template**-pacing drop arrives as `failed` + **132015**, which already maps
  to `template_unavailable` — and the accompanying `message_template_status_update`
  (`PAUSED`) is what halts the rest of the campaign, via the halt described in
  [whatsapp-templates.md](whatsapp-templates.md) §25;
- a **portfolio**-pacing drop arrives as a `failed` status webhook with code **135000**, mapped to
  `portfolio_paced_drop`. Nothing about that recipient is wrong and retrying them
  changes nothing: it is an account-level event reported per message, and the
  portfolio is already blocked pending Meta's review. Appeals go through Business
  Suite, which is what the message tells the operator.


---

## Per-user marketing limits (131049)

WhatsApp caps how many marketing templates an individual receives **from any
business**, adapting to that person's own read rate and inbox activity. It is not
about us and the person made no choice about us — which is why it is recorded
separately from an opt-out and expires on its own.

Also folded into the same error: **US phone numbers receive no marketing
templates at all** since 2025-04-01. The two causes are indistinguishable in the
response, so the operator-facing message names both. Per-user limits are not
active for numbers in the EEA, UK, Japan or South Korea.

**The rule that changes behaviour**: wait **24 hours** before resending to a
capped user. Resending sooner earns the same error, *and* a WABA that repeatedly
retries capped users can have delivery to those users cut off for up to 24 hours.
So:

- a 131049 status webhook stamps `Contact.marketingCapReachedAt` (mirroring how
  131050 stamps the opt-out);
- broadcast audience resolution excludes contacts capped in the last 24h,
  counting them into `suppressedCount` beside the opt-outs. **Marketing category
  only** — a utility or authentication template must still reach them, exactly
  like the opt-out rule it sits next to;
- the window is rolling, not sticky. Nobody has to clear a flag.

Retrying a finished campaign was already safe and stays that way: 131049 arrives
*after* a successful send, so the recipient's `status` is `sent` (with
`deliveryState: undelivered`), and `retryFailed` only re-queues `status: failed`.
The bucket is `suppress`, so the report never offers them for retry either.


---

## Failure buckets are an INSTRUCTION, not a taxonomy

The report tags every failure with a bucket, and the UI turns that into a chip
telling the operator what to do:

| Bucket | Chip | Means |
|---|---|---|
| `retryable` | Can retry | transient — re-sending should work |
| `permanent` | **Clean list** | the RECIPIENT is unreachable — remove them |
| `suppress` | Don't retry | a standing choice or a limit; keep the contact |
| `content` | Fix the message | our fault; every recipient fails until it changes |

`permanent` is the only chip that tells someone to **delete a contact**, which
makes the default arm of `failureBucket` load-bearing. It used to return
`permanent`, so every code without an explicit case inherited "clean list" —
including `marketing_opt_out`, which meant an operator was told to delete a live
customer because they had turned off *marketing* while still receiving their
order updates. `portfolio_paced_drop` and `call_permission_required` landed there
too, and our own content faults (a duplicate button title) pointed at the contact
list instead of the template.

Now every code is bucketed explicitly, the default is the conservative
`suppress` (an unrecognised code can't be claimed to mean a bad number), and a
test asserts both the individual verdicts and that nothing quietly inherits one.
