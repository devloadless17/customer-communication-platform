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
