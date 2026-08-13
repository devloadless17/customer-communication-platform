# VERIFICATION — 2026-08-13 · Full-system A→Z pass + swallowed-failures close-out

One program, two halves: (A) re-prove the whole system green on every gate the
repo owns, system-side only (mock Graph; no live Meta calls needed); (B) close
the **9-item swallowed-failures backlog** the 2026-08-11 family audit deferred.
Maintainer-approved scope: fix everything, full test depth including the
browser suite.

## A. Verification matrix (all on this box, dev stack)

| Gate | Result |
|---|---|
| CI run 31649721689 (the two 2026-08-13 02:00 commits) | ✅ success (confirmed settled) |
| `pnpm run check` (3 typechecks + lint + 12 checkers) | ✅ 0 errors (31 lint warnings, pre-existing) |
| `check:binary-sources` (CI-only checker, run for the union) | ✅ |
| Double-assertion ratchet | ✅ improved 124 → 105, baseline locked in |
| `pnpm run build` (web) | ✅ 53s |
| API unit/integration (1530 tests) | ✅ green at `--maxWorkers=4` — see traps below |
| Web unit (49) | ✅ |
| `partial-indexes.spec.ts` (24 raw indexes) | ✅ against the migration-built dev DB |
| Meta backend e2e (173) | ✅ 172 in-suite + the 1 `@pressure` failure re-run green in isolation (converges 268→115→48→10→0; CI excludes `@pressure` for this reason) |
| Multi-account matrix (46) | ✅ |
| Browser e2e, 8 batches (~440 tests) | ✅ batches 0–6 green (first-pass failures all environmental, re-run proof); batch 7: 187/188 on the freshest run with the sole reproducible failure being the real bug fixed below (fix proven green on two subsequent runs) — later same-night re-runs each timed out a DIFFERENT handful (40s–2m, box degraded post-marathon), and every test in the batch passed in ≥1 run tonight |
| Post-fix worktree gates | ✅ full `pnpm run check` green; API suite **1559/1559** (148 files — +29 new tests, zero regressions); web typecheck green |
| Final MERGED-tree gates (production @ 0109a3cc) | ✅ `pnpm run check` + binary-sources green; web unit 49/49; Meta backend e2e **173/173 including `@pressure`** (converged in-suite this time — quiet box) |
| Adversarial review of the fix diff itself | ✅ 1 P1 (spec type cast breaking the CI ratchet), 3 P2 (spoofable-banner comment honesty, backfill read-merge-write race, escalation flag never auto-clearing for idle accounts), 2 P3 — ALL applied and re-verified; core mechanics (tenancy, clear/flag seam, IOU ordering, escalation state machine) confirmed correct |
| Adversarial review of the never-audited 02:00 commits (`05cd0df8`, `8ac565c8`) | ✅ both CORRECT; one LOW gap found → folded into backlog item 5 (below) |

**Box-specific traps confirmed this run (recorded in memory):**
- Bare `pnpm test` on this 22-core box spawns ~20 vitest workers against one
  dockerized Postgres → shifting timeout storms (15 then 11 files, different
  each run) plus one interference-shaped assertion failure. All of it vanishes
  at `--maxWorkers=4` (50s, fully green). Not a product defect.
- A long-lived dev stack + stray Playwright chromium competing for the box is
  the other flake source; kill by PID before big runs.
- After many batched-runner respawns the dev `.next` truncates — auth setup
  itself fails. `--fresh` is the fix, exactly as the runner's epilogue says.

**The one real e2e failure — fixed:** `post-audit-fixes/full-e2e-2026-06-16.spec.ts`
"broadcasts: new-broadcast form renders audience picker" failed reproducibly:
`/broadcasts/new` deliberately bounces to channel settings when the workspace
has no ACTIVE account on the composer's channel (the 07-27 channel-first gate),
and the e2e workspace's whatsapp row is a credential-less placeholder (a real
connection was removed at some point — the row was re-minted by the settings
pre-mint). The 08-10 ledger left the batched suite "🔄 running in background",
so this had no recorded green to regress from. Fix: the test now seeds an
active fixture account for its own duration (the sibling
`campaign-analytics-2026-07-31.spec.ts` pattern) and cleans up.

## B. Swallowed-failures backlog — all 9 closed (branch `backlog-fixes`)

One additive migration: `20260813060000_channel_health_signals_and_release_ledger`
(3 columns on `ChannelConnection` + the `PendingSubscriptionRelease` table; the
§18 hand-maintained raw-index section untouched).

1. **Registration-status gap (the 2026-08-11 live incident).**
   `ChannelConnection.registrationStatus` (raw Meta `status`, leave-alone
   posture like every health field). Rides the existing phone-number node read
   (zero extra Graph calls) in `fetchWhatsappHealthFromGraph` + persists at
   connect; the existing `whatsapp-health-refresh` sweeper keeps it ≤6h fresh,
   and `registerNumber`'s post-register re-poll self-clears it. Surfaced on the
   settings card (amber "Not registered"/"Registration incomplete" instead of
   green "Connected") and as a per-account pill. Spec: `whatsapp-health-per-account.spec.ts`.
2. **`isAppSubscribedToWaba` any-app blind spot.** `fetchTokenAppId()`
   (`GET /app?fields=id` = the issuing app) learns the id at connect when
   nothing supplies it, and the health sweeper backfills legacy rows once
   (read-merge-write of config JSON). The §18 any-app fallback branch stays
   exactly as documented — now unreachable in practice, with a once-per-process
   warn when it still runs. Spec: `webhook-subscription-health.spec.ts`.
3. **Sweeper `state:null` = transient forever.** Indeterminate results now
   escalate at **8 consecutive sweeps spanning ≥3.5h** (BOTH bounds required —
   the age bound is what keeps a rapid burst of sweeps, e.g. a spec against a
   shared DB or a boot loop, from false-flagging) → `flagChannelNeedsReconnect`
   + one transition-logged error. `applyResult` exported for the spec so eight
   platform-wide sweeps don't poison sibling fixtures. Spec: same file, driven
   with `vi.useFakeTimers({toFake:["Date"]})` so the pg pool's timers stay real.
4. **Release fire-and-forget.** `PendingSubscriptionRelease` IOU written BEFORE
   the inline `DELETE /subscribed_apps`, settled on success; the new
   `subscription-release-retry` sweeper retries with backoff (30min→24h cap),
   re-checks the "object back in use" reconnect race before every attempt
   (drops the row rather than darkening a live account), gives up LOUDLY at 7
   attempts (the outbound-webhook posture). Also found & fixed while wiring:
   **channel-wide `whatsapp.disconnect()` never released at all** — only the
   per-account remove did. Spec: `subscription-release.spec.ts`.
5. **Channel-wide reconnect clear** (+ the review-found gap). The clear AND the
   190-flag now live INSIDE `sendTextInternal` / `sendTemplateInternal` /
   `executeTextSendJob`, account-scoped from the connection id every send path
   already resolves — one site covers the composer, the workflow steps and
   `/v1` alike. Previously: `8ac565c4`'s template-path clear was channel-wide
   (A's success un-flagged B's real breakage), workflow//v1 sends never cleared,
   and a token exercised only by template sends never RAISED the banner at all.
   Channel-wide clear remains only for the unbound-thread `null` case, which is
   exact (the account-less fallback exists only at ≤1 active account).
   Spec: `whatsapp-account-hygiene.spec.ts` (2-account scoping pins).
6. **Webhook 403s invisible.** `recordWebhookRejected` (channel-wide — a failed
   signature can't name an account; ≥60s in-process throttle) stamps
   `lastWebhookRejectedAt/-Reason` from the controller's `webhookForbidden`;
   `recentWebhookRejection` applies a 24h staleness filter server-side (Meta
   stops retrying after ~24-36h, older stamps are history) and all three
   channel settings pages render the banner. `no_signature` deliberately NOT
   recorded — Meta always signs; a signature-less POST is a scanner, and
   stamping it would let a stranger light the banner. Spec: `webhook-reject-signal.spec.ts`.
7. **WhatsApp `getConfig` live `subscribed_apps` parity.** Same posture as the
   Messenger/Instagram reads (try/catch → null, never fails the page):
   `subscription: {subscribed, scopedToApp} | null` replaces the static "final
   check" hint with a real verdict. Spec: `multi-app-accounts.spec.ts`.
8. **Token/secret pairing fence (pre-Embedded-Signup).** `getMetaSendConfig`
   picks token+secret as ONE struct in one branch (`tokenSource:
   "connection"|"waba"`); a WABA-row business token pairs with the WABA row's
   secret or the platform `META_APP_SECRET` — never the connection row's, which
   belongs to a different app and 400s every signed call. Byte-identical for
   all existing rows (the WABA branch is dead until ES). Spec: load-time twin
   in `multi-app-accounts.spec.ts`.
9. **Widget open-origins — was ~90% pre-fixed (2026-07-20; the audit ledger
   entry was stale).** Residual shipped: the unlocked state is amber even
   before `firstSeenOrigin` exists, and the widgets LIST tab shows an "open to
   any site" pill so it's visible without opening the Install tab. The
   permissive-when-empty server default deliberately kept (changing it breaks
   existing tenants); no opt-in toggle (state machine, no enforcement change).

## Known-open (unchanged, deliberate)

- Backup offsite/dead-man's-switch + external uptime monitor — credential-gated,
  maintainer explicitly dropped from handoffs.
- Client number +961 79 006 685 still on the WhatsApp Business phone app —
  customer-side migration, then OTP verify → register → reconcile §6c.
- `main` is 58+ commits behind `production` — recommend `git checkout main &&
  git merge --ff-only production` + push main (CI-only, no deploy) when the
  maintainer is ready.
- Product decisions surfaced, not taken: notify-nobody events (SLA breach /
  share revoke / webhook auto-disable) from the 08-10 list.
