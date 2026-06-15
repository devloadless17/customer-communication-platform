# Full production-grade system audit (2026-06-15)

Zero-compromise whole-platform audit: inbox/realtime, state, DB/indexes, backend
perf/N+1, workflows, webhooks/integrations, architecture/resiliency, cache, code
quality. Method: 8 domain agents over 590 files → adversarial verification of
every high/critical finding against source. Audited the current working tree.

## Headline verdict (brutally honest)

**This is a genuinely production-grade platform.** Across 8 independent deep
passes: **0 critical, 1 high (SSRF — now FIXED), 1 medium, the rest low/info.**
The hot paths the business depends on — inbox realtime, message send/receive,
ingest, workflows, webhooks, broadcasts — are not just correct, they're
*defended in depth* with documented rationale at nearly every non-obvious choice.

**The dominant risk on this codebase is over-tinkering, not defects.** Multiple
agents independently flagged that the bus, fanout table, reducer hub, reconnect
machinery, shutdown sequence, loop-guards, and index set are load-bearing and
should be left alone. Treat the findings below as *polish on a strong base*, not
a remediation list.

## Production-readiness scores (1–10)

| Dimension | Score | Note |
|---|:--:|---|
| Architecture | **9** | Clean layering (madge: 0 cycles across all 3 packages), DB-free shared, framework-agnostic lib, two-tier bus, transactional outbox. |
| Performance | **9** | Zero genuine N+1 found on any hot path; every fan-out bounded-concurrency; hot reads denormalized; keyset pagination index-backed. |
| Reliability | **9** | Per-subscriber isolation, per-event ingest try, graceful-shutdown ordering with race cap, self-respawning workers, fail-loud boot guards. |
| Realtime | **9** | Every event scoped to the minimal room; 3 storm vectors killed; 3-layer reconnect convergence; cache-patch matrix closed by a dev invariant. |
| State Management | **9** | Reducer-hub + `assertReducerCoverage` + LRU snapshot-on-leave + count-based optimistic reconcile — best-in-class for plain-React-no-store. |
| Database | **9** | Every index traceable to a query + revisit trigger; FK-delete scans closed; redundant indexes actively pruned; channel-scoped dedupe. |
| APIs | **9** | id-first multi-channel addressing, mandatory send idempotency, layered authz, consistent include fragments. (Consistent with the prior 88/100.) |
| Workflows | **9** | Dual-axis depth caps, per-run Redis lock + heartbeat, type-driven idempotency journaling, graph-cycle rejection. Strongest subsystem. |
| Webhooks | **9** | *(8.5 pre-fix.)* Bounded retries, per-delivery breaker, X-CCP-Depth/Origin-Key loop guards, SSRF guard — the one hole (SSRF) is now closed. |
| Maintainability | **8** | Exceptional WHY-comments + structural guards; docked for three very large hot-path files (watch-item, not a defect). |

## Critical issues
**None.** No data-loss, outage, duplicate-processing, or incorrect-behavior
defect found on any path.

## The one HIGH — FIXED this session

**SSRF block-list bypass via hex IPv4-mapped IPv6** (`apps/api/src/lib/http/safe-fetch.ts`).
- **Root cause:** `isBlockedIpv6` matched only the *dotted-decimal* mapped form
  (`::ffff:1.2.3.4`). `dns.lookup` returns AAAA records verbatim, so an
  attacker-controlled record resolving to `::ffff:7f00:1` (127.0.0.1),
  `::ffff:a9fe:a9fe` (cloud IMDS 169.254.169.254), or `0:0:0:0:0:0:0:1`
  (expanded `::1`) fell through to `return false` (allowed). Reachable from the
  outbound-webhook delivery worker and the workflow `http_request` step — both
  team-admin-configurable URLs — and the M1 DNS-pin *guarantees* the connect
  lands on the bad address.
- **Verification:** adversarially confirmed with a live Node repro (the request
  reached a 127.0.0.1 server and returned its body).
- **Fix (applied):** rewrote `isBlockedIpv6` to **expand any IPv6 notation to
  numeric groups** (`expandIpv6`) and classify on bits — IPv4-mapped + NAT64
  embedded-v4 re-checked against the v4 block list regardless of hex/decimal
  notation; loopback/unspecified caught in any zero-compression; fe80::/10,
  fc00::/7, ff00::/8 by mask. Verified against a 17-case matrix (13 malicious
  forms blocked, 4 public IPs allowed). Typecheck-green.

## Performance issues
1. **MEDIUM — inbox `counts()` fans 11 parallel COUNTs; 5 unread variants have no
   `unreadCount` index** (`conversations.service.ts:131-200`). Flagged
   *independently* by the DB and backend-perf agents. Latent at pilot scale
   (single-digit ms), but it's the most-repeated DB work in the inbox and scales
   with total conversation volume. **Fixed the stale doc-comment now**;
   **recommended:** a hand-written partial index `Conversation(teamId) WHERE
   unreadCount > 0` (tiny — zero-unread rows dominate; do NOT add a full
   unreadCount index — it'd bloat every markRead write). Add when EXPLAIN justifies.
2. **LOW** — workflow runner rewrites the full `stepLog` + `stepOutputs` JSONB on
   the run row after every step (O(N²) bytes for a long run). Bounded by step
   count; deliberate. Optionally append-only the stepLog if a run ever exceeds
   ~50 steps.
3. **LOW** — per-connect presence SELECT (`buildVisibleOnlineSnapshot`) and a
   per-delivery double row-read in the webhook worker. Both micro; documented
   pilot-scale-acceptable.

## Realtime issues
- **LOW** — viewer-pill / typing-indicator flicker on sub-30s reconnect blips
  (`handleDisconnect` broadcasts leave/typing-stop that connection-state-recovery
  then re-adds). The one real rough edge. Fix: defer the leave-broadcast by a
  short grace window (or gate it on recovery-expired). Cosmetic.
- **LOW** — same-second message ordering can differ between live-append
  (arrival order) and reconnect-refetch (id-sorted). Near-zero user impact;
  arguably document arrival-order as intentional rather than "fix."
- Otherwise: **zero duplicated broadcasts, zero feedback loops, zero
  missed-on-reconnect paths, zero over-wide fanouts** found.

## State management issues
- **LOW** — `ContactPanel` keeps a parallel, independently-derived copy of live
  conversation state (status/counts/assignee) — a knowingly-deferred shortcut,
  low impact. Could subscribe to the shared reducer instead.
- **LOW/latent** — the `useTeamEvents` socket effect relies on an implicit
  "sync refs during render, never in useEffect" contract the dep-linter can't
  see. No bug today; add a one-line invariant comment at the dep array so a
  future edit can't silently reintroduce the stale-ref class.

## Workflow / event issues
- **LOW** — `WorkflowContactState` once-per-contact ledger has no `Contact` FK
  and no cleanup sweeper (orphan rows accumulate; harmless under soft-delete,
  matters only if a hard-purge is added). Add the FK (SetNull/Cascade) when a
  purge path lands.
- **LOW** — a crashed `ask_question` *resume* is presumed-complete by
  orphan-detect, silently taking the default/timeout branch (drops the answer
  routing). Rare; consider not classifying the resume pickup as a side-effecting
  step so a crash re-runs the routing.
- **INFO** — orphan-delivery re-enqueue drops `chainDepth` (loop-guard resets to
  0 on recovery). Bounded; note it.

## API / payload issues
Covered exhaustively by the prior business-context audit (see
[docs/architecture-deep-audit-2026-06-15-business-context.md](docs/architecture-deep-audit-2026-06-15-business-context.md))
+ the now-applied fix batch (ai_enabled, lean contact block, interactive
option_id, status timestamp, closedByApiKeyId, workflowId attribution, etc.).
This pass surfaced no *new* payload gaps.

## Cleanup opportunities (all low/info)
- Dead `EventProvider` type alias contradicts the "no provider concept" rule — delete.
- Stale comment references a non-existent `fetchLastInboundMap` helper — remove.
- `Contact` carries two overlapping `deletedAt` indexes (full `(teamId,deletedAt)`
  + partial `(teamId) WHERE deletedAt IS NULL`) — drop the redundant one.
- Global `searchContacts` orders by `createdAt DESC` with no `(teamId,createdAt)`
  sort-support after the trgm bitmap — low-priority refinement at ~50k contacts.
- Three very large files (`ingest.ts`, `use-conversation-events.ts` ~1618 lines,
  `inbox-shell.tsx` ~1625) — cohesive + heavily commented, but a watch-item for
  future split.

## What is world-class — do NOT churn
The reducer-hub + `assertReducerCoverage` invariant; the `fanout-rules.ts`
compile-checked event table; optimistic↔confirmed count-based reconciliation; the
3-layer reconnect convergence + leaked-timer guard; the two-tier event bus +
transactional outbox; dual-axis workflow depth caps + per-run Redis lock +
type-driven idempotency journaling; bounded-concurrency at every fan-out; the
index-to-query traceability + active redundant-index pruning; the
ciphertext-caching credential store; graceful-shutdown ordering. These are the
reason the platform scores as high as it does.

## Bottom line
Ship-ready for pilot. The single security fix (SSRF) is applied + verified. The
one performance item (counts partial index) is a cheap, well-understood follow-up
to add when EXPLAIN justifies. Everything else is documented polish on a mature,
defended base — the right move is restraint, not refactoring.
