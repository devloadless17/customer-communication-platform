# Deep architecture audit — business-context completeness (2026-06-15)

Scope: API · Events · Triggers · Workflows · Webhooks · Integrations · Payloads.
Lens: does every event/webhook/trigger/API-response carry the **correct business
context** — enough, not too much, correct, stable, future-proof — with no
integrator callback forced and no bloat.

Method: 16 agents (6 surface-mappers + 5 cross-cutting lenses + 5 adversarial
verifiers). Every high/critical finding was verified against source before
inclusion. Audited the **current working tree** (includes the prior fix pass +
the two fixes applied in this pass).

## Verdict

The **spine is production-grade and must not be churned** — the dominant risk
here is over-tinkering, not under-building. Verified strengths: explicit
previous+new on every state transition; a single canonical mutation layer
(`lib/conversations/mutations.ts`) shared by UI/API/workflow so business rules
can't drift; CAS-guarded transitions; a typed exhaustive fanout map (a forgotten
event is a compile error); an allowlisted wire contract (not publish-everything)
with rawPayload fenced off every surface; structured `{type,id}` sender/assignee
with a reserved `ai_agent` discriminator (real forward-compat); the
silent/skipOutboundWebhook split (loop-safe AND partner-visible); transactional
outbox for the inbound path; structural broadcast isolation; layered idempotency
+ depth caps + origin-key loop guards; a genuine multi-channel seam.

**Zero critical findings. Zero correctness/security/loop bugs.** Every issue is
**business-context completeness at the wire/trigger boundary** — exactly the
owner's stated #1 fear — and almost every fix is an additive field through an
existing mapper, not a restructure.

## Scores (/100) — post the fixes applied this session

| Dimension | Score | One-line basis |
|---|---:|---|
| API Architecture | 88 | Clean v1 isolation, layered authz, mandatory send-idempotency; papercuts (externalContactId dead lookup, response-envelope drift). |
| Event Architecture | 90 | Taxonomy, projection discipline, actor-discriminator, outbox — near-exemplary; deductions are context gaps not design. |
| Workflow Architecture | 87 | Deterministic core is ~90; dinged by token/branch source split + media_url-empty + incoming_webhook no-context. |
| Payload Design | 88 | The owner's core axis. No bloat anywhere; gaps were ai_enabled + conversation-context (fixed now) + interactive optionId. |
| Webhook Design | 89 | Strongest surface; was 84 pre-fix (ai_enabled), now restored. Doc-vs-wire drift remains. |
| State Transition | 92 | Textbook: explicit prev+new, canonical layer, CAS, cause→effect ordering, auditable. |
| Integration Readiness | 89 | Path-versioning, stable wire contract, full correlation/idempotency/trace, real multi-channel seam. |
| Simplicity | 86 | Predictable publish sites + legible flags; one exception (message.sent null-then-enrich needs tracing). |
| Maintainability | 89 | Compile-error fanout map, single mutation layer, documented invariants, degrade-don't-drop. |
| Future Scalability | 88 | Every scale cliff is an already-documented prepared seam; no new unprepared cliff found. |

## Findings (verified)

### Applied this session
- **[was HIGH] `ai_enabled` always true on `message.received`** — FIXED.
  `toPublicEnvelopes` built the conversation block without `aiEnabled`, so
  `toWirePayload`'s `d.conversation?.aiEnabled ?? true` collapsed to the team flag
  and a paused thread reported `ai_enabled:true`. *Business impact:* directly broke
  the per-conversation human↔AI handoff — a partner bot replies over a human who
  took over. *Fix:* added `aiEnabled` to `PublicConversation` + spread
  `e.conversation.aiEnabled` into the message.received block (public-events.ts).
- **[was MED] `message.received`/`message.sent` drop conversation status/unread/
  is_new_conversation/reopened on the wire** — FIXED. *Business impact:* partner
  couldn't detect a brand-new vs reopened thread, nor current status, without a
  `GET /v1/conversations/:id`. *Fix:* added a `conversation { status, unreadCount,
  isNewConversation, reopened }` block to both wire cases (data was already on the
  envelope; only the wire transform dropped it).

### HIGH (open — recommend next)
- **CSV-imported new contacts never fire `contact.created`** (confirmed HIGH).
  `importCsv`'s `createMany` path publishes only the socket-only
  `contact.bulk_updated` (which is NOT in the webhook allowlist); the revive path
  and every other create path DO fire `contact.created`. *Business impact:* a
  partner's "On Contact Created" webhook silently misses every bulk import — the
  dominant onboarding path. *Location:* contacts.service.ts:1042-1067 vs 1022-1030.
  *Fix (decision needed):* either (a) fire per-row `contact.created` (matches every
  other path + partner expectation, but N webhooks per import) — recommend pairing
  with `suppressSocketFanout` so the socket keeps the coalesced frame; or (b) add
  `contact.bulk_updated` to the webhook allowlist as a distinct bulk event. (a) is
  more partner-intuitive; (b) bounds volume. **Owner picks the volume tradeoff.**

### MEDIUM (open)
1. **Interactive button/list `optionId` dropped everywhere except ask_question**
   (was HIGH→MED). The stable author-assigned id is captured by the parser then
   discarded; `message.received` body carries only the localized title. *Impact:*
   button-tap automations/webhooks must match brittle title strings. *Fix:* thread
   `interactive {kind,id,title}` onto the message domain → WorkflowMessageSnapshot
   → PublicMessage/wire; add an `option_id` workflow condition field.
   ingest.ts:919-937; public-events.ts:530-558.
2. **Send-failure reason reaches the partner webhook + DB but NOT the inbox socket
   frame** — the agent sees a bare red icon; the integrator knows *why*. Inverts the
   info hierarchy. fanout-rules.ts:116-123. *Fix:* forward errorCode/Title/Detail on
   the `message:status` frame (failed only) + reducer + bubble tooltip + hydration
   select.
3. **`note.created` carries `author_user_id` but no name** — every other actor is
   name-hydrated; notes force a `GET /v1/users/:id` per note. *Fix:* add note author
   to `hydrateUsers` (one line). subscriber.ts:448-502.
4. **Non-message webhooks (conversation.*, contact.tag/lifecycle, note.*) carry
   only `contact_id`, not a contact block** — partners key on phone, so each forces
   a contact callback. *Fix:* stamp a LEAN `{id, phoneNumber, name}` block (already
   on the event for conversation.*; a batched lookup for contact.*). **Owner
   confirms which lean fields earn their place — do NOT ship full custom_fields.**
5. **`$var.contact.*` tokens read LIVE DB while branch presets read the pinned
   snapshot** — non-deterministic across a wait/ask_question pause (branch on one
   value, interpolate a newer value). token-context.ts:28-68. *Fix:* one source of
   truth per run (recommend uniform-live: feed the live ContactLike to branch
   presets).
6. **Inbound `media_url` is always empty in the workflow envelope** — async media
   download lands after the pinned snapshot; the outbound-webhook subscriber
   re-reads it but the workflow runner has no equivalent. *Impact:* "customer sends
   image → OCR/forward" silently sends blank. *Fix:* re-read mediaUrl by id before
   token/envelope use (mirror subscriber.ts:364). ingest.ts:1065-1094.
7. **`incoming_webhook` trigger carries no contact/conversation** (`contact:null`
   hard-wired) — its advertised `contact_*` conditions can never match and every
   contact/conversation step no-ops. *Fix (interim):* hide contact_* conditions +
   badge contact-targeting steps for this trigger; (real) the deferred 2c "match/
   create contact from body" step. workflows.service.ts:867-873.
8. **Outbound `/v1` replies lose reply context on the message.sent webhook** —
   only the inbox-UI send attaches the `replyTo` snapshot; /v1 sets only
   `replyToMessageId`. *Fix:* back-fill `reply_to` in the subscriber's enrichMessages
   (same role as media.url). external-v1-messaging.service.ts:626-639.
9. **Partner/workflow conversation close loses actor on the analytics row**
   (`closedByUserId` written null; no `closedByApiKeyId` column). The audit row
   keeps it; the durable denorm drops it. *Fix:* add `Conversation.closedByApiKeyId`
   mirroring `closedByUserId`. (migration)
10. **Workflow-driven mutations are un-attributable in the timeline** (no
    `workflowId` actor → renders as "System"). *Impact:* "why did this chat close
    itself" is unanswerable. *Fix:* add `changedByWorkflowId` + `ConversationEvent.
    workflowId`. (migration)
11. **Docs render `contact.updated.field_changes` as an OBJECT; the wire is an
    ARRAY** — a doc-driven parser breaks. public-events.ts:341-348. *Fix:* one-line
    sample correction to `[{key,previous,next}]`.
12. **Built-in field edits (name/email/location) are absent from `field_changes`
    and fire no workflow trigger** — only conveyed via the full contact block.
    *Fix:* document the custom-fields-only scope, or add built-in keys with a
    deliberate trigger decision.
13. **`externalContactId` is a documented /v1 lookup + response field with no write
    path** — always null on WhatsApp, lookup always empty. *Fix:* accept it on
    create/upsert and write it through, or remove the dead surface.

### LOW / INFO (catalog)
status_changed has no timestamp; inbound contact tagNames/stageNames absent (ids
present); workflow/broadcast sender collapse to `type:'workflow'`; socket
assign/status/ai frames omit the actor; `conversation.deleted` has no api-key/
system actor variant; `source:"import"` declared-but-never-published; phantom
`contact.assignee` in docs; http_request body uses pinned snapshot while tokens use
live (two contact states in one call); `$var.conversation.*` never re-fetched;
ask_question answer only on the immediately-next step; ExternalMessage REST omits
reply context the webhook carries; response-envelope `{ok:true}` inconsistency;
channel.meta stringified blob (explicit partner ask — keep); ~20-field analytics
snapshot pinned on every WorkflowRun (shared-mapper reuse — acceptable); uncached
per-event Team.aiAutopilot read; per-step contact re-fetch not memoized; webhook
vs /v1 timestamp unit differs (ms vs ISO); per-route /v1 60/min redundant with the
guard's 60/min; contact-event deliveries have an at-most-once crash window (plain
publish vs publishInTx); stale "identityChannel is null for WhatsApp" comments;
docs sample omits deleted_by_api_key_id; recentMessages window comment overstates
(~50 vs 10); closing an AI-paused conversation fires a second (ai_changed) webhook.

## The 8 questions

1. **Are events carrying the correct business context?** Overwhelmingly yes for the
   internal bus (explicit prev+new, full actor attribution, rich contact on
   message.received). The gaps are at the *wire/trigger projection*: ai_enabled
   (fixed), conversation status/new/reopen (fixed), interactive optionId, workflow
   media_url, incoming_webhook contact.
2. **Missing payload attributes?** After this pass: interactive `option_id`;
   workflow `media_url`; failure reason on the inbox socket; note author name; a
   lean contact block on non-message webhooks; reply context on /v1-origin sends.
3. **Unnecessarily heavy payloads?** Essentially none — rawPayload is fenced
   everywhere, recentMessages is bounded (10), envelopes capped (256KB). The only
   duplication is `channel.meta` (an explicit partner requirement). This codebase
   errs toward correct-and-lean, not bloat.
4. **Poorly designed events?** None are poorly *designed*. The weakest *projection*
   is `message.received`'s wire (now improved) and `incoming_webhook` (structurally
   context-less until the deferred 2c step lands).
5. **Workflows lacking context?** `incoming_webhook` (no contact/conversation);
   media-dependent runs (empty media_url); and the token/branch determinism split on
   slow/paused runs.
6. **APIs needing restructuring?** None structurally. Additive only:
   `externalContactId` write path, `ExternalMessage.replyTo`, uniform response
   envelope. /v1 versioning + authz + idempotency are already solid.
7. **Painful at scale?** Nothing unprepared. Every cliff (single-socket/no-Redis-
   adapter, in-memory rate-limit + grow-only caches, in-process broadcast loop,
   per-team in-process fairness) is a documented seam with a stated trigger. The
   real ceiling is single-VPS/single-socket — by design for the pilot.
8. **Top 20 — see below.**

## Top 20 improvements (to world-class)

1. ~~Restore `ai_enabled` on message.received~~ ✅ done.
2. ~~Carry conversation status/new/reopen on the message wire~~ ✅ done.
3. Fire `contact.created` for CSV-imported new contacts (pick volume strategy).
4. Thread interactive `option_id` through to the wire + workflow condition.
5. Forward send-failure reason to the inbox socket frame + failed-bubble tooltip.
6. Hydrate `note.created` author name (one line in hydrateUsers).
7. Stamp a lean `{id, phoneNumber, name}` contact block on non-message webhooks.
8. Re-read inbound `media_url` into the workflow envelope before token use.
9. Surface the `incoming_webhook` no-contact limitation at author time; then ship
   the "match/create contact from body" step (deferred 2c).
10. Pick one contact source-of-truth per workflow run (token vs branch).
11. Back-fill `reply_to` on /v1-origin `message.sent` (enrichMessages).
12. Add `Conversation.closedByApiKeyId` + thread it to the closed trigger.
13. Add workflow-actor attribution (`changedByWorkflowId` + `ConversationEvent.
    workflowId`) so the timeline says "closed by workflow «name»".
14. Fix the `field_changes` docs sample (object→array) and reconcile the docs page
    against the actual wire (phantom `contact.assignee`, wrong source enum).
15. Give `externalContactId` a write path (or remove the dead lookup/response).
16. Add `ExternalMessage.replyTo` + `senderApiKeyId` so push and pull models match.
17. Decide built-in-field-change semantics: itemize in field_changes (+ trigger) or
    document the custom-fields-only scope.
18. Add a `timestamp` to `message.status_changed` (all three views).
19. Cache the per-event `Team.aiAutopilotEnabled` read on the existing channel-cache
    invalidation; memoize the per-step workflow contact re-fetch per run.
20. Normalize the partner-facing timestamp contract (webhook ms vs /v1 ISO) and
    document it; unify the response-envelope shape across /v1 mutation routes.

## Do NOT touch (load-bearing)
The bus + SubscriberPriority tiers; the allowlist + structural broadcast isolation;
the canonical mutation layer + CAS + cause→effect ordering; the silent/
skipOutboundWebhook split; the transactional outbox; the enrich-at-subscriber seam;
idempotency/depth/origin-key loop guards; the multi-channel `deriveEventChannel`
seam. These are the reason the system scored as high as it did.
