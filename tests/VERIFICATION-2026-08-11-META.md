# Verification Ledger — 2026-08-11 META program

The single authority on what this program verified, how, and when. Lens:
**Meta correctness under a real customer's configuration** — every claim the
system makes about Meta state, checked against Meta's documentation and Meta's
live API, the day before real clients onboard. Triggered by a live incident:
a customer app with "Require app secret" ON exposed that four layers of Graph
calls were unsigned, and pulling that thread found a family.

Method codes: **D** = verified against Meta's CURRENT docs via the DevTools
MCP · **L** = verified against LIVE Graph with real credentials (client's and
operator's own) · **R** = adversarial code-reading pass (5 parallel reviewers
+ 4 family sweeps + 1 completeness critic) · **N** = new targeted tests.
Everything below is green at HEAD unless marked open.

---

## What was verified, by mechanism

| Domain | Method | Outcome |
|---|---|---|
| `appsecret_proof` formula/placement/coverage | D+R+N | Formula/params match spec; ALL Graph-origin call sites signable; `scripts/check-appsecret-proof.mjs` (canary-validated) pins the class in CI. Six settings-layer, three WABA-subscription, three health, seven calling, three sticker call sites were unsigned — all fixed same-day. |
| Credential token/secret pairing | R+N | Own-app store-time pair preservation (messenger + IG), probe proofs paired by token tier, resync passes no Page token (guard bypass closed). My own first-pass fix was WRONG (Page token can't read `instagram_business_account`; broke reconnect) — caught by two independent reviewers, reverted, redesigned. Pinned in `multi-app-accounts.spec.ts`. |
| WhatsApp webhook field coverage | D | Every documented `whatsapp_business_account` field handled or deliberately quiet-dropped; per-change attribution, batching contract, `account_update` id semantics, status/error shapes, 2026 changes (billable deprecation, v24 conversation omission, new offboard/reconnect triggers) all current. |
| Messenger/Instagram surface | D+R | Envelopes, Page-subscription field enum (incl. `messaging_seen` exclusion), IG-from-Page resolution, Advanced Access gating (runbook §6b) all doc-current. Sticker dual-attachment cutover 2026-08-30 handled on both sides. |
| Templates & messaging limits | D+L+N | Status/category vocabulary complete; `parameter_format`/carousel posture unchanged; tier ladder current (TIER_1K legacy-tolerated); UNTIERED = "no tier assigned" (wire-observed, NOT documented) rendered honestly in 4 UI sites; budget gate ADVISORY on the over-counting branch (hard only on audience>cap). Changelog swept through 2026-08: nothing unaccounted. |
| Onboarding path (runbook) | D+R+L | Handshake + HMAC match spec; verification-before-registration enforced in warnings (`code_verification_status` was fetched-and-dropped); debug_token 4xx = definitive pair-rejection warning (was silent while inbound dropped forever); registration budget copy corrected; phone-app-held numbers get the migration step (§5) and the reconciler is §6c. |
| Stored-mirror truth (reconciliation) | L+N | `apps/api/scripts/meta-reconcile.ts` + pure comparator (+spec): SYSTEM vs live Graph per field, auto-heal via existing paths. Round 1 (client creds): converged 0 drift. Round 2 (operator creds): 55 match / 0 drift incl. full template catalog. Maiden run caught `persistWhatsappHealth` clobbering the portfolio's real TIER_250 with number-level UNTIERED on every poll — fixed + pinned (`whatsapp-account-hygiene.spec.ts`). |
| Frontend truth & liveness | R+N | Six stuck-forever pending states fixed (no-finally awaits); "Save hours" spinner was disabled-state rendered as loading; calling readiness no longer asserts "2,000+ ✓" on an unknown tier (requirement itself confirmed: error 138015). |
| SSRF posture | R | Avatar capture was the ONE Meta-bound fetch outside safeFetch — now guarded, redirects off (CDN 302 hole). Spec moved to the safeFetch seam. |

## Completeness-critic round (second session)

| Finding | Outcome |
|---|---|
| `broadcast-delivery-drift` counter reconcile | **Was DEAD ON ARRIVAL**: referenced a nonexistent `Broadcast."updatedAt"` — 42703 on every tick, eaten by its fail-soft catch. Also full-scanned all BroadcastRecipient rows. Fixed (COALESCE settle guard + per-tick id bound) and pinned in `broadcast-delivery-drift-counters.spec.ts` — the spec's first run is what exposed it. Lesson re-learned: raw SQL is invisible to every typechecker; a fail-soft catch needs a loud counter. |
| `adoptCustomerMemories` at the BSUID site | Ran on the bare client AFTER the customer delete — crash window stranded person-level memories forever. Now one transaction; helper contract rewritten (delete-first INSIDE the tx is correct; atomicity, not ordering, is the requirement). |
| `resolveStepTarget` whatsapp scoping | Assumption verified against the real partial unique (`Contact_workspaceId_phoneNumber_whatsapp_key` IS whatsapp-scoped); impersonation direction + ghost-revive pinned in `workflow-target-phone-scope.spec.ts` (3 green). |
| Deploy pipeline fail-closed pg_dump | Exercised by the day's green deploys — closed. |
| Coexistence history worker / CAPI / sticker proof / ingest-call outbox pin | Unchanged code, low risk — parked with reasons in the memory ledger. |

## Known-open (deliberate, documented)

- Registration status (`status`/`code_verification_status`) has no stored
  mirror/sweeper — warned at connect, reported by the reconciler, deferred as
  a product decision.
- `isAppSubscribedToWaba` with no stored appId counts any subscriber (shared-
  WABA blind spot); resync failures list and swallowed-failures backlog in
  the 2026-08-11 memory ledger.
- Client number +961 79 006 685 still lives on the WhatsApp Business phone
  app — migration → OTP → register is the customer's step, not code.

## The day's meta-lesson

Four deploy failures and one dead feature were all caught by guards
(spec pins ×3, NUL checker, and a first-ever spec) — none by users. When a
contract changes, update the unit spec AND its e2e twin in the same commit;
when raw SQL ships, its spec must run against a real database in the same
commit, because nothing else can see it.

## Live local round (2026-08-13, night before launch — real creds, real Meta)

Full-loop rig: dev stack + local DB + ngrok tunnel on the app's own dashboard
callback. Verified LIVE: three-channel reconcile 57/0 after reconnecting
messenger+IG through the real flow (fresh Page tokens — the reconnect path the
review saved); app dashboard truth via meta_test MCP (5 topics, fields richer
than required, rate limits 2%, v26, zero deprecations); inbound with REAL
third-party traffic incl. Meta's ~30h webhook RETRY BACKLOG redelivered on
tunnel-up — messages carried their ORIGINAL timestamps and the monotonic
lastInboundAt/window clock handled late redelivery exactly right (initially
misread as a staleness bug; it was the system being correct); UI truth
(tier/quality/budget/IDs/window gates all honest); outbound template send via
the UI → wamid → DELIVERED receipt back through the tunnel.

Two defects found & fixed live: the reconciler's social block probed with
wrong id/token-field/result-shape (3 bugs, mine — every alarm vindicated the
system); and `needsReconnect` cleared only on the TEXT send path — an account
recovering from a dead token almost always has a closed window, so its first
healthy send is a TEMPLATE, which never cleared the banner. Clear added to the
template success path; verified live (flag flipped false on the next send).
