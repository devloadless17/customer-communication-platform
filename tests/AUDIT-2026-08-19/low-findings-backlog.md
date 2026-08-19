# Low-severity backlog — all waves + sweeps (2026-08-19)

### U1a-03 — Social media downloads run for events that will never be ingested (opted-out comments, unknown-account groups)
- **file:** apps/api/src/webhooks/meta/meta-webhook-ingest.service.ts:458
- **claim:** downloadSocialMedia is invoked with the FULL parse output (`events`) after the non-DM source gate and the unknown-account partition have already excluded events from `ingestable`/`groups` — so attachments on an opted-out account's comments and on unknown-account events are fetched from the CDN and uploaded to R2 with no Message row ever created. completePendingMedia then skips them (no row), leaving orphan blobs until the blob-orphan sweeper deletes them ~24h later.
- **fix:** Pass the union of `ingestable` groups' events (or filter by the same gate) to downloadSocialMedia instead of the raw parse output, mirroring how the WhatsApp path downloads per attributed group.

### U1a-04 — WhatsApp events persist the WHOLE batched envelope as each row's rawPayload — write amplification up to batch size
- **file:** apps/api/src/lib/providers/meta.ts:1380
- **claim:** Every WhatsApp emit passes `rawPayload: payload` (the entire POST body), unlike the social parser which slices per messaging item (rawPayloadOf(m)). Under Meta's documented batching (up to 1000 updates per POST, and 'changes from different objects may be batched together'), N message rows each store the full N-event envelope — O(N²) bytes of rawPayload written for one delivery. Consumers that search it (hadMedia, the inbound-media sweeper's media-id recovery) already walk every entry, so a per-change slice (entry+change wrapper) would preserve their contracts.
- **fix:** Emit a per-change (or per-entry) slice of the envelope as rawPayload for message/echo events, keeping the object/entry/change wrapper so forensic replay and hadMedia keep working; social already demonstrates the pattern.

### U1a-05 — Deactivated account on its own Meta app: HMAC candidate set excludes it, partially defeating inbound-accounts' documented tolerance
- **file:** apps/api/src/lib/providers/config.ts:594
- **claim:** resolveInboundAccounts deliberately omits an isActive filter so 'a number that was deactivated in the UI still attributes its in-flight inbound instead of silently losing it' (inbound-accounts.ts:108-111) — but all three webhook-config loaders (getMetaWebhookConfig, getMessengerWebhookConfig, getInstagramWebhookConfig) build the HMAC candidate list from `isActive: true` rows only. A deactivated connection whose app secret exists only on its own row (own-app connection, no active sibling on that app, shared Meta secret different) 403s at the signature check, so its in-flight inbound never reaches the attribution layer that was built to accept it.
- **fix:** Include recently-deactivated (or all) rows' secrets in the webhook-secret candidate set — a secret the team itself configured never widens trust (the controller's own verifySignature comment says exactly this).

### U1a-06 — AppLevelResolution.via always reports "waba_id" regardless of which attempt matched
- **file:** apps/api/src/lib/providers/app-level-webhook.ts:253
- **claim:** resolveEntry declares via: 'waba_info' | 'waba_id' | 'portfolio_id' | 'account_id' but hardcodes { via: "waba_id" } on every successful attempt, so the discriminator is dead/misleading — a portfolio-id or social-account match claims it resolved by WABA id.
- **fix:** Derive via from the matched attempt (attempt.what maps 1:1), or delete the field.

### U1a-07 — App-level partial-throttle 429 carries no Retry-After header
- **file:** apps/api/src/webhooks/meta/meta.controller.ts:281
- **claim:** The guard's 429s set Retry-After (which its own comment notes Meta respects and which keeps us off Meta's broken-webhook board), but the handler-level 429 thrown when any co-batched group was throttled sets no Retry-After, and the bucket's retryAfter value is discarded at the consume site (:251).
- **fix:** Capture rate.retryAfter from the failed consume and set the header on the thrown HttpException, mirroring WebhookRateLimitGuard.

### U1a-08 — A Coexistence phone-app reply never stamps ticket first-response
- **file:** apps/api/src/lib/messaging/commit-outbound-send.ts:92
- **claim:** commitOutboundSend gates markFirstResponse on senderUserId || senderApiKeyId to exclude workflow auto-acks — but an echo (the owner personally replying from the WhatsApp Business app) also carries both null, so a genuine human response routed through ingestOutboundEcho never stops the ticket's first-response clock.
- **fix:** Treat origin 'business_app' as a human response (thread an origin flag through commitOutboundSend, or stamp first-response from the echo path explicitly) — or document the exclusion as a product decision beside the workflow-auto-ack rationale.

### U1a-09 — Business-side unsend from Meta's native social inbox parses as a customer correction and is dropped by the direction pin
- **file:** apps/api/src/lib/providers/meta-social.ts:954
- **claim:** parseSocialMessaging checks m.message.is_deleted BEFORE the is_echo branch and emits a message_correction with no expectedDirection; ingestMessageCorrection then defaults the pin to 'in' (ingest.ts:716), so if Meta ever delivers a business-side unsend as is_echo+is_deleted on message_echoes, the target row is direction 'out', the pin mismatches, and the tombstone is silently skipped — the agent's copy diverges from what the customer sees, the exact class the WhatsApp smb echo revoke path (expectedDirection:'out') was built to fix.
- **fix:** If the wire shape exists, branch on is_echo within the is_deleted check and emit expectedDirection:'out'; if Meta never delivers echo unsends, add a comment saying so where the is_deleted branch precedes is_echo.

### U1a-10 — Per-workspace webhook bucket is consumable pre-authentication by anyone who knows a workspaceId
- **file:** apps/api/src/webhooks/webhook-rate-limit.guard.ts:56
- **claim:** The guard consumes a token from the team bucket (600/min) before the controller's HMAC check, and a 403'd garbage-signature request still spends the token. An attacker who learns a workspaceId (it appears in the callback URL configured in Meta dashboards, support screenshots, etc.) can exhaust that workspace's bucket from a distributed set of IPs (the 1200/min per-IP bucket only bounds a single source), 429ing the tenant's real Meta deliveries. Impact is delay, not loss (Meta retries with backoff, dedupe absorbs), plus webhook-health noise.
- **fix:** Note as accepted (cheap-rejection-first is a standard trade), or refill the team token on auth failure / key the pre-auth throttle by IP only and the post-auth throttle by workspace.

### U2b-05 — Edit round-trip rewrites unknown carousel card-button types to QUICK_REPLY (top-level buttons deliberately preserve them)
- **file:** apps/web/src/features/templates/components/template-form.tsx:1775
- **claim:** hydrateCarousel maps every non-URL card button to kind 'QUICK_REPLY' with no `raw` passthrough, and carouselDraftToComponent emits only URL/QUICK_REPLY — so a Manager-authored card COPY_CODE (or any future) button type is silently mutated on an edit resubmission. Top-level buttons were explicitly fixed for this exact class (ButtonRow.raw, toMetaButton keepType).
- **fix:** Carry the original card-button object through the draft (raw passthrough) as toMetaButton does, or refuse to hydrate a carousel containing button types the editor can't represent.

### U2b-06 — Editing a limited-time-offer template silently forces has_expiration: true
- **file:** apps/web/src/features/templates/components/template-form.tsx:350
- **claim:** hydrateFromTemplate keeps only the LTO heading (:1747) and the components memo re-emits `limited_time_offer: { text, has_expiration: true }` unconditionally (:349-351). templateNeedsOfferExpiry documents that has_expiration:false is a valid Meta shape requiring NO expiry parameter — an edit of such a template (authored in Manager) flips the flag on resubmission.
- **fix:** Hydrate has_expiration into the draft and re-emit the stored value instead of hardcoding true.

### U2b-07 — Template-status webhook re-stamps archivedAt on redelivery, pushing the 28-day deletion deadline forward
- **file:** apps/api/src/lib/providers/ingest.ts:1318
- **claim:** ingestTemplateStatusUpdate writes `archivedAt = evt.status === 'archived' ? new Date() : null` unconditionally, while catalog-sync.ts:249-255 deliberately stamps archivedAt only on the TRANSITION 'so a later sync doesn't keep pushing the deadline forward and hide an expiring template'. Meta delivers webhooks at-least-once, and the affected rows' previous status is already loaded (:1395-1398) but not consulted for this field.
- **fix:** Preserve archivedAt when the affected row's current status is already 'archived' (the `affected` read has the previous status in hand).

### U2b-08 — reconcileWaba is outside the per-WABA fail-soft — one WABA's DB error aborts the whole sweep and 500s the Sync button
- **file:** apps/api/src/lib/templates/catalog-sync.ts:152
- **claim:** The header promises 'fail-soft per WABA', and config resolution + fetchTemplates are wrapped — but `await reconcileWaba(...)` at :152 (a $transaction of upserts + a deleteMany) is not. A transient DB error, tx timeout, or upsert unique-race (two concurrent syncs) on WABA A propagates out of syncTemplateCatalog: remaining WABAs are skipped this run and the controller surfaces a raw 500 instead of the structured sync_failed/partial result.
- **fix:** Wrap the reconcileWaba + backfill call in the same try/catch that guards fetch, pushing into result.failed.

### U2b-09 — bodyNamed accepted on a POSITIONAL template silently switches the wire to the named shape (opaque 132000 instead of a named refusal)
- **file:** apps/api/src/lib/messaging/send-template-internal.ts:728
- **claim:** For a positional template, validation checks only body count (:229-236) and never rejects a supplied bodyNamed; the provider's buildTemplateSendComponents gives bodyNamed precedence (meta-template-parse.ts:93-101), so the send goes out with parameter_name entries Meta rejects. The stored preview also renders by bodyNamed presence, not parameterFormat (:787-789). This violates the codebase's own 'name the refusal' posture for /v1 callers.
- **fix:** In sendTemplateInternal, refuse (or strip) bodyNamed when template.parameterFormat !== 'named', and key the preview render on isNamed rather than payload presence.

### U2b-10 — Inbox fill view demands manual entry of the auth OTP button value the server exists to autofill
- **file:** apps/web/src/features/inbox/components/template-picker/fill-view.tsx:146
- **claim:** requiredTemplateButtonParams returns the auth OTP button with autofillFromBody:true; the server fills it from body[0] ONLY when the caller supplies nothing (send-template-internal.ts:305-314). The fill view renders a VarField for every requiredButtons entry and allFilled demands it non-empty (:297-299), so an agent sending an auth template from the inbox must type the code twice — and a typo makes the button copy a different code than the body shows, the exact failure the autofill design documents preventing.
- **fix:** Filter autofillFromBody buttons out of the fill view's rendered/required set (mirror the server: they are derived from body[0]).

### U2b-11 — POST /templates (sync from Meta) has no @RateLimit despite being a full multi-WABA Graph catalog fetch
- **file:** apps/api/src/workspace-settings/whatsapp/whatsapp-templates.controller.ts:92
- **claim:** The sibling Graph-read routes are capped (library 30/min, compare 20/min, analytics refresh 10/min, health/refresh precedent 6/min) precisely because each call costs live Graph reads — but the sync POST, which pages EVERY WABA's entire catalog (up to 6,000 templates each) plus library backfill lookups, runs at the 300/min default.
- **fix:** Add @RateLimit({ perMinute: 6 }) (or similar) matching the health/refresh precedent; the sweeper and webhook paths are unaffected.

### U2b-12 — Positional-placeholder whitespace tolerance is split between the authoring and send/render regexes
- **file:** packages/shared/src/template-render.ts:29
- **claim:** positionalPlaceholderIndices accepts `{{ 1 }}` (\s* in the regex, :338) while countTemplatePlaceholders (:31) and renderTemplateBody (:17) require `{{1}}` exactly. templateNamedPlaceholders/renderTemplateBodyNamed both tolerate whitespace, so only the positional pair disagrees. A body containing `{{ 1 }}` validates as a 1-variable positional template at authoring (examples demanded) but counts 0 variables at send time and never renders the value.
- **fix:** Give the four regexes one tolerance: either add \s* to countTemplatePlaceholders/renderTemplateBody or remove it from positionalPlaceholderIndices (and templateNamedPlaceholders for symmetry).

### U10-04 — Handshake siteKey not length-capped before use as attacker-chosen cache key
- **file:** apps/api/src/webchatwidget/webchatwidget.gateway.ts:207
- **claim:** visitorId is sliced to 128 chars but siteKey is not; resolveWebchatwidgetByPublicKey caches a null result keyed by the full attacker-chosen string (webchatwidget-config.ts:244). Bounded to 10k entries by TtlCache but not by bytes; maxHttpBufferSize (64KiB, ws-adapter.ts:95) caps each key, so worst case is a few hundred MB of transient negative-cache strings from a sustained multi-IP probe — nuisance memory pressure, not a practical outage.
- **fix:** slice siteKey (e.g. 0,128 — real keys are 54 chars) in the handshake and in the public controller's resolve() before it reaches the cache; or refuse to negative-cache keys longer than the minted format.

### U10-05 — Install docs promise 'localhost always works' but production refuses loopback once origins are locked
- **file:** apps/web/src/app/docs/webchat-install/page.tsx:146
- **claim:** Sections 5 and 7 tell the customer's developer that localhost always works with no allow-list entry, but origin-allow.ts:58-61 (correctly, post-hardening) refuses loopback origins in production once allowedOrigins is non-empty — and the widget always talks to the production API, where NODE_ENV=production. The origin-allow.ts header comment (lines 7-9) carries the same stale claim.
- **fix:** Update both the docs page and the origin-allow.ts header: 'localhost works until you configure Allowed domains; after locking, add localhost (or 127.0.0.1) to the list while developing'.

### U10-06 — 'End chat' on a never-chatted widget stamps the next first-ever conversation as a restart
- **file:** apps/web/public/widget.js:558
- **claim:** doReset() sets S.startedNew = true unconditionally — including the silent path taken when the visitor has never chatted (requestReset: 'nothing to lose'). Their actual first message then carries startedNew:true and the gateway records a 'Visitor started a new conversation' timeline note (gateway.ts:427-434) on a conversation that is not a restart.
- **fix:** Only set S.startedNew when there was something to restart — e.g. gate it on the pre-reset lsGet(K.chatted)/S.formDone the silent branch already computed in requestReset.

### U10-07 — Tenancy hygiene: four internally-sourced-id queries omit workspaceId against §7's unconditional rule
- **file:** apps/api/src/lib/providers/webchatwidget-config.ts:298
- **claim:** webchatwidgetAiAllowed (:298) and webchatwidgetShowsAgentName (:332) read conversation.findUnique by bare id; gateway.ts:715 reads aiMessageMetadata by messageId-in without workspaceId though the table has one; webchat-prechat.ts:305 (contact.updateMany by id+version) and :349 (contact.findUnique by id) likewise. All ids are server-resolved (parent-scoped in practice, not exploitable), but the same gateway's markOutbound explicitly carries workspaceId 'to keep the §7 invariant unconditional' (gateway.ts:614-615) — the unit is inconsistent with its own stated standard, and none of these tables are schema-documented TENANCY EXCEPTIONs.
- **fix:** Thread workspaceId into the two config helpers' where (callers have it or the conversation row returns it for a belt-and-braces compare) and add workspaceId to the aiMessageMetadata and contact follow-up queries.

### U10-08 — Connected sockets keep a stale config snapshot: policy changes don't reach live visitors until reconnect
- **file:** apps/api/src/webchatwidget/webchatwidget.gateway.ts:246
- **claim:** data.resolved is captured at handshake and used for the socket's lifetime: widgetAllowsMediaKind at send (line 324) and preChatFieldTargets (line 447) read it. Saving the widget invalidates every cache but cannot update live sockets, so an admin's policy change (attachments off, question unbound, widget deactivated) doesn't bind an already-connected visitor. Enforcement mostly holds because the upload endpoint re-resolves fresh per request — but a visitor holding a pre-change mediaKey can still SEND it under the stale snapshot, which is exactly the hole the send-time re-check comment (lines 321-323) says it exists to close.
- **fix:** Re-resolve config on the policy-relevant paths (resolveWebchatwidgetByPublicKey is cached, so calling it in onVisitorMessage costs a map hit per send), or refresh data.resolved when the cache entry it came from is invalidated.

### U1b-03 — Page-subscription release 'still in use' checks are workspace-scoped while the subscription is app-scoped
- **file:** apps/api/src/workspace-settings/channel-accounts/channel-accounts.service.ts:628
- **claim:** releaseSubscription's stillInUse count (and objectBackInUse in subscription-release-retry.ts:136-144) only counts THIS workspace's messenger/instagram connections on the pageId. DELETE /{page-id}/subscribed_apps removes the calling APP's subscription to the Page entirely, so when the same Page is connected in a sibling workspace under the same Meta app (ChannelConnection uniqueness permits it — the unique is per-workspace, and one org's workspaces can paste the same shared app), removing it from workspace A takes workspace B's inbound dark.
- **fix:** Widen the still-in-use count to all workspaces whose connection stores the same appId (or, cheaper, any workspace at all sharing that pageId), and document the residual case; the WhatsApp half is already safe because externalWabaId is globally unique.

### U1b-04 — MetaChannelConfig declares the wabaId field its own docblock forbids
- **file:** apps/api/src/lib/providers/config.ts:30
- **claim:** `wabaId?: string;` sits on MetaChannelConfig immediately above the comment 'NO `wabaId` HERE… two copies of one fact that could drift.' Nothing writes it anymore (whatsapp.service newConfig explicitly omits it), but pre-refactor rows may still carry a stale JSON value, and the declared field invites new code to read `config.wabaId` — compiling clean and returning the stale legacy copy instead of the WhatsappBusinessAccount FK join.
- **fix:** Delete the interface field (and optionally strip the key from stored config on the next updateConfig save).

### U1b-05 — MessengerPersona queries omit workspaceId despite the model's own 'in every query' pledge
- **file:** apps/api/src/lib/providers/messenger-persona-registry.ts:86
- **claim:** resolvePersonaId's findUnique (lines 86 and 130) key on (channelConnectionId, userId) with no workspaceId, while prisma/schema.prisma:1137 documents the column as present 'and in every query (CLAUDE.md §7)'. Not exploitable today — both ids originate from workspace-scoped reads (the thread's connection, the session user) — but MessengerPersona is not on the schema's TENANCY EXCEPTION allowlist either, so the code contradicts the documented discipline the tenancy audits key on.
- **fix:** Add workspaceId to both queries (findFirst with the compound fields + workspaceId), or add a schema TENANCY EXCEPTION note declaring it parent-scoped like the TeamChannel satellites.

### U1b-06 — teamConnectedChannels swallows every loader error as 'channel not connected'
- **file:** apps/api/src/lib/providers/index.ts:189
- **claim:** The bare `catch {}` around getSendConfig treats ANY throw — a transient DB error, a Prisma pool blip, an unexpected bug — the same as ProviderNotConfiguredError, silently excluding the channel from bestChannelForCustomer targeting. The comment claims only 'Not connected / creds expired' land here.
- **fix:** Catch ProviderNotConfiguredError specifically; rethrow (or at least log with the error class) anything else so infrastructure failures stay distinguishable from disconnection.

### U1b-07 — isTokenError classifies any OAuthException as 'access token dead (Graph 190)'
- **file:** apps/api/src/lib/sweepers/webhook-subscription-health.ts:164
- **claim:** isTokenError matches the substring 'OAuthException', but Graph delivers permission errors (code 200 family) and other auth-shaped failures under that same type — so a token that is alive but under-scoped is reported as 'access token dead (Graph 190) — reconnect required', a wrong diagnosis with alarming copy (and, combined with U1b-02, it fans out to WABA siblings).
- **fix:** Parse the error code out of the body and treat only code 190 (and explicit subcode families for expiry/revocation) as token-dead; let other OAuthExceptions ride the indeterminate-escalation path, which already exists for persistent non-190 causes.

### U2a-04 — clientTempId accepts unbounded length on most send schemas
- **file:** apps/api/src/messages/messages.schemas.ts:6
- **claim:** SendTextSchema, SendTemplateSchema (208), SendLocation/SendContacts, ForwardMessagesSchema (573) validate clientTempId as z.string().min(1) with no max, while SendStickerSchema (612) and the messenger-template schema cap it at 128. The value flows into Redis job ids, the in-process idempotency map key (5000-entry cap counts entries, not bytes), and OutboundSendAttempt.jobId.
- **fix:** Add .max(128) (matching the sticker schema) to every clientTempId field.

### U2a-05 — Synchronous send paths (media/forward/template/interactive/structured/sticker via the composer) have no crash-surviving idempotency ledger
- **file:** apps/api/src/messages/messages.service.ts:2143
- **claim:** Only the queued text path writes OutboundSendAttempt. The sync composer paths rely on the in-process runWithSendIdempotency map, which dies with the process; the post-send never-throw discipline covers in-process failures but not response loss across a process death.
- **fix:** Either accept and document (as the workflow-send bypass is documented in the assignment README), or write an OutboundSendAttempt row keyed msg-media-<workspaceId>-<clientTempId> before the Meta send on the media path — the highest-volume sync sender.

### U2a-06 — auth_expired flag / needsReconnect self-heal wired only into the text and template funnels, not the other five internal senders
- **file:** apps/api/src/lib/messaging/send-interactive-internal.ts:348
- **claim:** Commit 46d62c44 added flagChannelNeedsReconnect-on-190 + clearChannelNeedsReconnect-on-success inside sendTextInternal and sendTemplateInternal ('covers composer, workflow steps and /v1'), but sendInteractiveInternal, sendStickerInternal, sendStructuredInternal, sendMessengerTemplateInternal and sendMediaInternal call the provider with neither: a 190 on those paths raises no reconnect banner, and a successful send through them does not clear a stale one.
- **fix:** Lift the flag/clear pair into a tiny shared wrapper around the provider call (or into commitOutboundSend's callers) so all seven internals behave identically.

### U7-06 — ExportFiltersSchema accepts arbitrary channel/source strings that are cast to Postgres enums in raw SQL
- **file:** apps/api/src/contacts/transfer.schemas.ts:37
- **claim:** channel and source are z.string().max(40) (unlike the list schema's zLiveChannel/enum), and buildContactFilterWhere interpolates them as ${channel}::"Channel" / ${source}::"ContactSource" — an invalid value makes the export job fail with a raw Postgres enum-cast error persisted as the job's error message instead of a 400 at submit.
- **fix:** Use zLiveChannel().optional() and the source enum in ExportFiltersSchema, mirroring ListContactsQuerySchema.

### U7-07 — Stale comment + inconsistent explicit-ids total in export countScope after the segments commit
- **file:** apps/api/src/lib/contact-transfer/export-runner.ts:240
- **claim:** countScope's comment still says 'with channel=webchatwidget explicitly selected, the shared filter opts anonymous visitors IN' — 9c3940b1 removed that opt-in, so the extra AND DIRECTORY_CONTACT_SQL here and in iterateContacts is now redundant and the comment describes behavior that no longer exists (CLAUDE.md §20: a stale doc is worse than none). Separately, the ids branch returns scope.ids.length as total while hydrate() drops non-directory/foreign ids, so the progress total can overstate and the bar never reaches 100%.
- **fix:** Update the comment (or drop the redundant AND), and count the ids branch with the same directory-gated query hydrate uses.

### U7-08 — Import tag-replace DELETE on _ContactToTag lacks the workspace backstops its bulk-tag twin carries
- **file:** apps/api/src/lib/contact-transfer/import-runner.ts:940
- **claim:** linkTags' replace-mode `DELETE FROM "_ContactToTag" WHERE "A" = ANY(ids)` has no workspace IN-subquery, while the equivalent destructive DELETE in contacts.service.ts:695-700 carries both backstops with a comment calling them deliberate defense-in-depth. ids are derived from a workspace-scoped query today, so this is a convention gap, not a live leak.
- **fix:** Add the same `"A" IN (SELECT id FROM "Contact" WHERE "workspaceId" = ...)` backstop as the bulk path.

### U7-09 — Manual link/unlink re-point skips the version bump and workspace-scoped write its identity-layer siblings use
- **file:** apps/api/src/customers/customers.service.ts:449
- **claim:** linkContact/unlinkContact re-point customerId via tx.contact.update({ where: { id } }) — no workspaceId in the mutation's where (ownership proven only by the earlier findFirst) and no version:{increment:1}, whereas contact-share.ts:150-153 and every bsuid-reconcile re-point bump version explicitly 'the same discipline' so concurrent agent PATCHes 409 instead of interleaving, and remove() documents putting workspaceId on the mutation itself as the convention.
- **fix:** Use updateMany({ where: { id, workspaceId } , data: { customerId, version: { increment: 1 } } }) in both paths.

### U7-10 — /v1 parity gap: the new `reach` filter (and segment counts) exist only in the UI
- **file:** apps/api/src/external/v1/external-v1.schemas.ts:361
- **claim:** §12/§18 lock 'every capability the UI has, the API has'. 9c3940b1 gave the UI a reach filter on list, bulk-filter and export plus a segment-counts read; /v1's ListContactsQuerySchema has no reach and no counts surface. check:v1-docs verifies scopes+docs, not filter parity, so nothing catches it mechanically.
- **fix:** Add reach to /v1's list (and document it on /docs/api); decide whether segment-counts is an 'action' the parity rule covers or UI chrome, and note the decision either way.

### U9-4 — Inspector advertises http_request output leaves (statusCode, body.<path>) that the runtime never produces — picker-inserted tokens silently resolve empty
- **file:** packages/shared/src/workflow-shapes.ts:354
- **claim:** STEP_OUTPUT_SHAPES.http_request declares `statusCode` and a `body` json leaf ('drill in via $var.previousStep.body.<path>'). But the runner's captureStepOutput (runner.ts:389-411) stores the PARSED RESPONSE BODY at the output ROOT (stepOutputs[stepId] = JSON.parse(result.body)), and field-tokens.ts:483-495 resolves $var.previousStep.<path> against that root. So `$var.previousStep.statusCode` is never populated, and `$var.previousStep.body.foo` only works for the non-JSON fallback case ({ body: rawText }) — for a JSON response the correct token is `$var.previousStep.foo`. The DataInspector click-to-copy inserts these wrong tokens.
- **fix:** Make the registry match reality: drop `statusCode`, replace the shape with a root-level json leaf documented as 'the parsed response body — $var.previousStep.<path>'. (Or make the runner store { statusCode, body } and bump the docs — but that changes existing working tokens.)

### U9-5 — workflow-worker.service.ts: three sweeper starts share try blocks (notification-retention, customer-link, assignment-rebalance) violating the file's own one-try-per-sweeper rule; the stop path has a misleading brace-less unconditional call
- **file:** apps/api/src/workflows/workflow-worker.service.ts:466
- **claim:** startNotificationRetentionSweeper (line 466) rides inside conversationEventRetention's try with no flag of its own; startCustomerLinkSweeper + startAssignmentRebalanceSweeper (lines 318-325) share contactDrift's try. The file itself documents at lines 588-591 why this is wrong: a throw in the first start silently skips the siblings, and a throw in a later start leaves the earlier sweeper running with its started-flag false — so it is never stopped on shutdown, quietly breaking the graceful-drain guarantee. The stop path at 676-688 compounds it: `if (this.conversationEventRetentionStarted) stopConversationEventRetentionSweeper(); stopNotificationRetentionSweeper();` — the second call is indentation-implied-conditional but actually unconditional (correct only by accident because stops are idempotent), and one throw in that shared block skips stopping the presence sampler + webchat/rawPayload retention sweepers.
- **fix:** Give notification-retention, customer-link, and assignment-rebalance their own try + started-flag + guarded stop, exactly like every other sibling; add braces to the stop block.

### U9-6 — AssignToEditor offers no overwrite toggle for mode=user — an escalate-to-named-teammate workflow cannot be expressed in the UI though the engine supports it
- **file:** apps/web/src/features/workflows/components/builder/step-editors.tsx:637
- **claim:** assign-to.ts parseConfig accepts `overwrite` on mode=user and documents 'set it when the workflow's whole purpose is a re-route (escalation)', and AssignTicketEditor renders the toggle for its user mode (line 2228) — but AssignToEditor gates the checkbox on `isAuto` (round_robin/policy only, line 624) and the mode=user radio onChange even drops a previously-set overwrite ({ mode: 'user', userId } at 633). So a fixed-user conversation assign is permanently fill-only from the builder.
- **fix:** Render the same overwrite checkbox for mode=user (copy AssignTicketEditor's), and preserve config.overwrite across the mode-radio onChange.

### U9-7 — Renaming an http_request custom-header KEY in the editor sends the literal redaction sentinel to the partner and silently loses the stored secret
- **file:** apps/api/src/workspace-settings/workflows/workflows.service.ts:227
- **claim:** redactConfig replaces every header VALUE with REDACTED_HEADER_VALUE keyed by name; the PATCH merge restores the ciphertext only when `oldH[k]` exists for the SAME key (line 228). If the author renames a header key in the textarea (value still shows the sentinel), the merge finds no old value under the new key, encryptGraphStepSecrets encrypts the sentinel itself, and at run time the step decrypts and sends `X-New-Name: •••••••• (saved)` to the partner — auth silently broken with a nonsense header value and the original secret unrecoverable via the UI.
- **fix:** In the merge, treat an incoming sentinel value with NO matching old key as an error (400 'retype the value for renamed header') or strip the header; in the editor, clear the value field when the author edits a key whose value is the sentinel.

### U9-8 — manualTrigger wraps domain 4xx conditions (contact not found) into a 500; plus two builder copy drifts (jump hint says 100-step ceiling, http timeout placeholder says 8000ms)
- **file:** apps/api/src/workspace-settings/workflows/workflows.service.ts:530
- **claim:** The catch in manualTrigger converts every dispatchManualTrigger throw — including the plain-Error 'contact not found' for a bad/stale contactId — into InternalServerErrorException, so the inbox 'Run workflow' button surfaces a 500 for a client-input problem (wrong status class, alarms error monitoring, violates the §13 structured-error convention). Separately: JumpToStepEditor's hint (step-editors.tsx:1367) claims 'The global ceiling is 100 steps' while MAX_STEPS_PER_RUN is 200, and HttpRequestEditor's timeout placeholder shows 8000 while the actual default is 30000 (http-request.ts:107).
- **fix:** Map 'contact not found' / 'workflow not found' to NotFoundException in manualTrigger's catch; update the two hint strings.

### U3-2 — Search loadMore has no in-flight guard — a re-fired sentinel double-appends the same page
- **file:** apps/web/src/features/inbox/hooks/use-inbox-search.ts:115
- **claim:** `loadMore` reads `cursorRef.current` and fetches with no `loadingMore` bail; `cursorRef` only advances when the response lands. useInfiniteScroll's contract comment says the callback must be self-guarding, and inbox-search-panel.tsx:108 fires it on every intersection — so two fires during one slow fetch request the SAME cursor twice and append duplicate rows (duplicate React keys, doubled hits).
- **fix:** Bail at the top of loadMore when `loadingMore` is true (mirror useConversationAttachments.loadMore), or dedupe appended items by id.

### U3-3 — Inbox-shell misclassifies the first real reconnect as first-connect when the socket was already up at mount — cache.clearExcept skipped once
- **file:** apps/web/src/features/inbox/components/inbox-shell.tsx:981
- **claim:** Unlike useConversationEvents (use-conversation-events.ts:1308) and useSocketReconnect (which explicitly 'burn the first-connect skip for the already-connected singleton'), the shell only does `socket.on("connect", onConnect)` with no `if (socket.connected) onConnect()`. On a soft navigation into /inbox with a warm socket, no connect event fires at mount, so `hasConnectedOnceRef` stays false and the FIRST genuine reconnect is consumed as 'first connect' — `cache.clearExcept(displayedId)` is skipped and stale non-displayed snapshots survive that reconnect.
- **fix:** After `socket.on("connect", onConnect)` add `if (socket.connected) hasConnectedOnceRef.current = true;` (or reuse useSocketReconnect).

### U3-4 — Availability `until` is withheld from the team on live frames but shipped to every teammate in the connect snapshot — documented boundary and UI diverge
- **file:** apps/api/src/realtime/realtime.gateway.ts:1112
- **claim:** The `user.availability_changed` fanout rule states '`manual` ... and `until` ... go ONLY to the user's own room, never to the team' and builds the team frame without `until` (fanout-rules.ts:858-886). But `emitAvailabilitySnapshot` includes `until: availabilityOverrideUntil` for every user in the frame sent to any connecting teammate (realtime.gateway.ts:1111-1114), and usePresence stores it for all users. So either the snapshot violates the fanout's stated privacy boundary, or (reading `until` as fair game) the two paths are simply inconsistent: teammates see 'until' only when it happened to be seeded by a snapshot, and a live override change never updates it for them until their next reconnect.
- **fix:** Pick one contract: either drop `until` from the snapshot's team copy (matching the fanout's stated boundary), or add `until` to the team fanout frame and update the fanout comment — then usePresence converges either way.

### U3-5 — ticket:changed contract docblock still describes the superseded twin-pair escalation model
- **file:** packages/shared/src/socket/events.ts:199
- **claim:** The `escalation_update` action is documented as 'The twin in the other workspace changed — ... the ticket's own lifecycle did not move', but the twin-pair design was superseded 2026-07-28 by the single shared-row TicketShare model (CLAUDE.md §2/§18) — there is no twin; the emitters in lib/tickets/shares.ts:341,479 and attachments.ts publish it for share-scoped changes on the ONE row. A contract comment describing a deleted model invites a future consumer to reason about (and rebuild) twin semantics; apps/web/src/app/(app)/tickets/[id]/not-found.tsx carries the same stale 'twin' copy.
- **fix:** Reword the `escalated`/`escalation_update` docblocks in terms of the shared single-row model (share granted / share-scoped state changed), and fix the matching stale copy in tickets/[id]/not-found.tsx.

### U3-6 — Handshake rate-limit bucket map is FIFO-on-insert, not the LRU the comment claims
- **file:** apps/api/src/realtime/realtime.gateway.ts:413
- **claim:** The comment says 'bounded LRU so a high-cardinality attacker can't OOM us', but entries are never re-inserted on hit, so eviction (`handshakeBuckets.keys().next().value`) removes the OLDEST-INSERTED key — typically the long-lived legitimate office NAT IP — and a re-created bucket starts at the full 200-token cap, resetting whatever budget it had consumed. Behavioral impact is negligible today (X-Real-IP is proxy-set so cardinality needs real source IPs), but the label misstates the mechanism and the eviction quietly refunds tokens.
- **fix:** Either re-set the entry on hit (true LRU) or change the comment to 'FIFO-bounded'; optionally evict the oldest-`ts` entry instead of oldest-inserted.

### U8-F5 — retryFailed reset clears errorCode/errorMessage but leaves metaErrorCode on re-queued recipients
- **file:** apps/api/src/broadcasts/broadcasts.service.ts:2372
- **claim:** The reset updateMany nulls status/deliveryState/errorMessage/errorCode/sentAt/externalId but not metaErrorCode, so a recipient that failed (e.g. Meta 131026), was retried and then delivered still carries the old raw Meta code.
- **fix:** Add metaErrorCode: null to the reset data (deliveredAt/readAt etc. are necessarily null on a failed-at-send row, so nothing else needs clearing).

### U8-F6 — Status badge labels every paused campaign 'Paused (auto-resumes)' — false for template and abuse_warning pauses
- **file:** apps/web/src/features/broadcasts/components/broadcast-status-badge.tsx:129
- **claim:** The badge hardcodes 'Paused (auto-resumes)', but the schedule-drift sweeper deliberately skips pausedReason='template' (operator must fix the template; only a deploy/boot resumes it) and abuse_warning pauses are liftable ONLY by the explicit operator Resume action (controller comment, broadcasts.controller.ts:228-233). The list row has no pausedReason, so the promise is wrong for exactly the pauses that need a human.
- **fix:** Ship pausedReason in the list DTO and branch the label ('Paused — needs attention' for template/abuse_warning vs 'Paused (auto-resumes)'), or drop the parenthetical to plain 'Paused' on the list and keep the reasoned copy on the detail page (which already branches on lastError).

### U8-F7 — Stale copy/comments contradicting current behavior: social empty-audience message suggests an option the same function rejects; customer-mode comment survives its removal; group-row claims a preview-slice that is actually complete; retryFailed 409 copy misleads for paused
- **file:** apps/api/src/broadcasts/broadcasts.service.ts:899
- **claim:** (a) create()'s empty_audience detail for a fully-account-dropped audience says 'turn on "include contacts from other accounts" to reach them' — but on messenger/instagram (where identityIsAccountScoped forces the drop) line 853-861 rejects that very flag as cross_account_not_possible and the UI hides the checkbox; the advice is impossible on the channels most likely to trigger it. (b) The freeform text-cap comment (lines 553-555) still explains a 'customer-mode resolves a channel per recipient' branch removed 2026-07-27 — capChannels' non-fixed-channel arm is dead code since the schema requires channel for freeform. (c) group-row.tsx:52 claims 'the list ships only a preview slice of the ids' while listAudienceGroups deliberately ships the COMPLETE contact-id list (lib/queries/audience-groups.ts:50-58 documents a revert of exactly that truncation). (d) retryFailed on a paused broadcast passes the first status guard, then the terminal-CAS miss surfaces as 'Another retry or run started for this broadcast' — misleading for a state where the right action is Resume or Cancel.
- **fix:** Branch the empty-audience copy on identityIsAccountScoped ('run one broadcast per account to cover everyone', matching the cross_account_not_possible wording); delete the dead customer-mode arm and comment in the freeform cap; fix the group-row comment; add a paused branch to retryFailed's first guard with 'Resume or cancel the paused broadcast first.'

### U8-F8 — 'Preparing recipients' (materializing) campaigns are unfilterable in the list rail though the API supports the filter
- **file:** apps/web/src/features/broadcasts/lib/broadcasts-cookies.ts:11
- **claim:** BroadcastListQuerySchema accepts status=materializing, and a 100k campaign can sit in that state for minutes (or strand until the drift sweeper recovers it), but BroadcastStatusFilter and the FILTERS rail in broadcasts-browser.tsx omit it — the rail's own comment says both operator-actionable states got chips so 'the campaign they just acted on' is findable, and materializing is cancelable (the backend allows it) yet invisible under every chip except All.
- **fix:** Add { id: 'materializing', label: 'Preparing', dot: 'bg-info-fg' } to FILTERS + the BroadcastStatusFilter union/VALID_STATUSES set (cookie parse already fails safe to 'all').

### U4-4 — correlationMiddleware's inline chain-depth parse is fail-open and mis-documents itself as mirroring the fail-closed parseChainDepth
- **file:** apps/api/src/common/correlation.ts:154
- **claim:** The middleware seeds ALS chainDepth with 'absent / invalid / non-positive → 0' and its comment claims it 'mirrors parseChainDepth in lib/workflows/events.ts' — but parseChainDepth (events.ts:52-57) returns MAX_CHAIN_DEPTH for invalid/negative input (fail-closed, per the 2026-06-19 security hardening). The enforcement gates (/v1 sends via external-v1.controller.ts parseChainDepth, workflow incoming-webhook workflows.service.ts:788) are fail-closed, so a mangled header cannot pass THOSE — but non-send /v1 writes (contacts, tags, tickets) publish events whose outbound-webhook deliveries stamp depth from this ALS value: a partner that echoes a corrupted X-CCP-Depth on a non-send loop resets the counter to 0+1 every hop, and the depth guard never trips (the X-CCP-Origin-Key guard covers only same-key loops).
- **fix:** Import (or truly mirror) the fail-closed semantics: invalid/negative → MAX_CHAIN_DEPTH in the middleware so a poisoned header propagates as 'over the cap' and the next outbound stamp trips the guard; at minimum correct the comment.

### U4-5 — readActiveWorkspaceCookie throws URIError on a malformed ccp.ws value — unhandled 500 on every API request and socket handshake for that browser
- **file:** packages/shared/src/auth/active-workspace.ts:255
- **claim:** decodeURIComponent(part.slice(eq + 1).trim()) throws URIError on malformed percent-sequences (verified: decodeURIComponent('%zz') throws). The call sites do not guard it: resolveSession (session.guard.ts:456) catches only AuthUnavailableError, so a cookie like ccp.ws=%zz turns every API request from that browser into a 500 instead of a clean fallthrough; socket-auth.service.ts:158 calls it outside its try blocks, erroring the handshake path. Only reachable by a tampered/corrupted cookie (the app writes raw cuids), so it is a robustness hole, not a security one — but an unhandled exception on pure client input in the hottest guard is below the codebase's bar.
- **fix:** Wrap the decodeURIComponent in try/catch and return null (treat an undecodable candidate as no candidate) — one-line change in the shared parser fixes all three consumers.

### U4-6 — startGoogleSignIn's next-path guard misses the backslash open-redirect normalization its login sibling explicitly hardened
- **file:** apps/web/src/app/login/google-actions.ts:25
- **claim:** The guard accepts raw.startsWith('/') && !raw.startsWith('//'), but loginAction's safeNext (login/actions.ts:45-55) additionally rejects any backslash because '/\evil.com' is normalized by URL parsers/browsers to a protocol-relative '//evil.com' — its comment calls the //-only check 'an open-redirect hole'. Here the value becomes Better Auth's callbackURL, i.e. the post-OAuth redirect target: /login?next=/\evil.com → Continue with Google → after the Google handshake the browser is bounced to evil.com. Better Auth validates callbackURL against trustedOrigins, which MAY reject the backslash form — unverified; the codebase's own convention is to not rely on that (which is why safeNext was hardened).
- **fix:** Reuse loginAction's safeNext (export it) or add `&& !raw.includes('\\')` to the condition — one line, and the two guards stop drifting.

### S2-1 — MessageReceivedEvent.silent contract half-implemented: workflow-dispatch never checks it
- **file:** apps/api/src/lib/events/subscribers/workflow-dispatch.ts:91
- **claim:** MessageReceivedEvent.silent is documented at packages/shared/src/events/types.ts:105 as 'Skip downstream reactions (workflows + outbound webhooks)', and the outbound-webhooks subscriber honors it generically (outbound-webhooks.subscriber.ts:177 `skipOutboundWebhook ?? silent ?? false`), but the workflow-dispatch message.received handler (workflow-dispatch.ts:91-105) has no `if (e.silent) return` guard — unlike its four sibling handlers (assigned:109, status:124, contact.updated:160, ticket.changed:263) which all do. The documented contract is therefore only half true for this event.
- **fix:** Add `if (e.silent) return;` at the top of the message.received subscriber in workflow-dispatch.ts (before the isNewConversation dispatch), matching the four sibling handlers — or, if silent is intended to be unsupported on this event, delete the field + its docblock from MessageReceivedEvent (and MessageSentEvent's mirror note) so no future publisher can rely on it.

### S2-2 — bus.ts load-bearing ordering rationale cites behavior workflow-dispatch no longer has (stale line refs)
- **file:** apps/api/src/lib/events/bus.ts:34
- **claim:** bus.ts:33-37 (and the SubscriberPriority docblock at :58-59) justify the AUDIT->ANALYTICS->WORKFLOW_DISPATCH ordering with 'workflow-dispatch re-reads conversation state (closedCategory / counters) that analytics writes (workflow-dispatch.ts:62,78)'. The current workflow-dispatch deliberately does the OPPOSITE for conversation events — its file header and handlers state the snapshot 'rides on the event payload' with analytics-predicted fields precisely so a concurrent mutation can't leak in (the M1 dispatcher contract; see workflow-dispatch.ts:80-82 and ConversationStatusChangedEvent's snapshot docblock). The cited lines 62/78 no longer contain a re-read. The ordering IS still load-bearing — but for different reasons (the outbound-webhooks subscriber DB-enriches message.sent with closedAt/firstResponseAt/assignee that analytics writes, and the ticket.changed handler DB-loads the contact) — so the comment defends a real invariant with dead evidence.
- **fix:** Rewrite the two bus.ts comment blocks to name the CURRENT dependents: (1) outbound-webhooks' DB enrichment of message.sent/conversation payloads reads rows analytics writes; (2) workflow ticket.changed loads the contact row; (3) auto-assign(25) must precede WORKFLOW_DISPATCH(30) so message_received workflows observe routing. Drop the stale workflow-dispatch.ts:62,78 references.

### S5-3 — Five live prose error keys in template literals violate the wire contract
- **file:** apps/api/src/team-chat/channel-messages.service.ts:780
- **claim:** Five HTTP envelopes carry a prose sentence in the `error` slot via backtick literals, all invisible to the checker: channel-messages.service.ts:780 (`file too large for ${kind}`), messages.service.ts:1747 and :3030 (`file too large for ${kind}: ${size} bytes > ${cap}` — also echoes internals into the key), contact-fields.service.ts:142 (`at most ${MAX_FIELDS_PER_TEAM} contact fields per team`), admin-organizations.controller.ts:57 (`cannot ${action} your own organization`). Per the contract (CLAUDE.md §13 + the checker's own docblock) these should be snake_case keys with the sentence in `detail`.
- **fix:** e.g. `{ error: "file_too_large", detail: \`…\`, cap }`; `{ error: "contact_field_limit_reached", detail: … }`; `{ error: "cannot_act_on_own_organization", detail: … }`.

### S5-4 — Prose sentences reach the error slot through variable indirection (unique-violation helper, password policy)
- **file:** apps/api/src/workspace-settings/contact-fields/contact-fields.service.ts:811
- **claim:** throwIfUniqueViolation throws `ConflictException({ error: detail })` where callers pass sentences ("field with that key already exists" at 229, "an option with this name already exists" at 448/478) — the parameter is literally NAMED detail yet lands in the error slot. Same shape at apps/api/src/auth/change-password.controller.ts:104: `{ error: policyError }` where validatePasswordStructure returns "Password must be at least 10 characters." — a sentence as the wire key.
- **fix:** throwIfUniqueViolation(err, key, detail) → `{ error: key, detail }`; password path → `{ error: "password_too_short" | "password_too_long", detail: policyError }` (validatePasswordStructure's return is also rendered directly by web forms, so map at the throw site rather than changing the shared function).

### S5-5 — ~19 web call sites still show the raw snake_case key instead of routing through apiErrorMessageFrom
- **file:** apps/web/src/components/layouts/workspace-switcher.tsx:118
- **claim:** The shared helper (packages/shared/src/api/error-message.ts, one definition of detail → humanized key → fallback) is used in 21 files, but these bypass it and render `data.error` raw when `detail` is absent: workspace-switcher.tsx:118 (touched 2026-08-10, AFTER the 2026-07-27 17-site fix 93e15467); ai-assistant-settings.tsx:149/413/595 ("Save failed: ${data.error}"); bubble-actions.tsx:87/217; profile-form.tsx:99; tags-settings.tsx:127/162/196; stages-settings.tsx:102/140/223; workflow-builder.tsx:356/463; export-dialog.tsx:110. Worse, inbox message-thread/utils.ts:62 and contacts-client.tsx:1459 render `${json.error}: ${json.detail}` — the machine key is shown even when a human sentence exists.
- **fix:** Replace each `d.detail || d.error || fallback` with `apiErrorMessageFrom(d, fallback)`; drop the `${json.error}: ` prefix at the two prefix sites.

### S5-6 — Server env-var name leaked to the browser in a thrown error message
- **file:** apps/api/src/messages/messages.service.ts:236
- **claim:** A string-arg exception sends "${label} isn't configured — set OPENAI_API_KEY." to the client as the Nest default `message` — internal server configuration (env var name, AI vendor) in a response body, and simultaneously a non-envelope body shape. Ops guidance belongs in the server-side log with the correlation id; the client needs only a key like `transcription_not_configured`.
- **fix:** `throw new ServiceUnavailableException({ error: "transcription_not_configured", detail: "Voice features are not configured on this server." })` and log the env-var hint server-side.

### S5-7 — PrismaExceptionFilter assumes an HTTP context but APP_FILTER also binds it to Socket.io handlers
- **file:** apps/api/src/common/prisma-exception.filter.ts:51
- **claim:** The filter calls `host.switchToHttp().getResponse<Response>()` and `res.status(...)` unconditionally. Registered via APP_FILTER (common.module.ts:24) it also receives Prisma errors escaping @SubscribeMessage handlers in both gateways, where getResponse() is not an Express Response — the filter itself then throws TypeError (`res.status is not a function`), losing the structured correlation log and the mapping, and replacing one clean error with two in the server log.
- **fix:** First line of catch(): `if (host.getType() !== "http") { this.logger.error(withCorrelation("prisma error in non-http context"), …); return; }` (or rethrow for the WS exception handler).

### S3-3 — Set-based drift reconcilers can transiently revert a concurrent live bump (READ COMMITTED EvalPlanQual re-check passes against the statement's stale snapshot)
- **file:** apps/api/src/lib/sweepers/contact-last-inbound-drift.ts:112
- **claim:** The single-statement UPDATE computes per-contact MAX from its snapshot; if an inbound commits its lastInboundAt bump after the snapshot but before the row is locked, EvalPlanQual re-evaluates 'lastInboundAt IS DISTINCT FROM sub.last_inbound' against the NEW row value and the OLD computed max — true — so the fresher value is overwritten with the stale one. Same class applies to the openFlagCount/openTicketCount/analytics recounts. Window is statement-length; next sweep (24h) self-heals.
- **fix:** Accept (window is milliseconds-scale and self-healing — this is the inherent cost of set-based reconcilers), or add a monotonic guard to the drift UPDATE (AND c.lastInboundAt < sub.last_inbound OR c.lastInboundAt IS NULL) at the cost of not correcting inflated values — probably only worth it for lastInboundAt where the value should be monotonic anyway.

### S3-4 — Recomputable denorms with no reconciler and no documented exemption: Conversation.lastMessagePreview/lastMessageAt/lastMessageDirection and team-chat threadReplyCount/threadLastReplyAt/TeamChannel.lastMessagePreview
- **file:** prisma/schema.prisma:2233
- **claim:** §7 states 'each one that CAN be recomputed has a drift sweeper', but its enumerated sweeper list silently omits these recomputable columns and no sweeper exists for them. They are maintained inline/in-tx and self-heal on the next message, and a cascade delete of the last message (or of thread replies via TeamChannelMessage deletion at channel-messages.service.ts:430's inverse paths) can leave a stale preview/count until the next write — cosmetic, but the handbook rule and the code disagree with no written exemption (unlike responsesCount/assignmentsCount, TicketThreadUnread and suppressedCount, which each carry an explicit no-sweeper rationale).
- **fix:** Either add these to the §7 documented-exclusion set with the one-line reason ('inline-maintained, self-heals on next message, drift is cosmetic') at the column comments, or fold a preview/count recount into the existing 24h per-team drift pass. Documentation is the proportionate fix.

### S7-3 — api-key.ts docblock contradicts the code it documents (token length and prefix width)
- **file:** apps/api/src/auth/api-key.ts:6
- **claim:** The module docblock says tokens look like `ccp_<32 hex chars>` and that 'the first 8 chars of the token' are stored as tokenPrefix; the code generates 48 hex chars (randomBytes(24), line 25) and stores a 12-char prefix (line 30), and looksLikeApiKey checks PREFIX+48 (line 40). In the one module where 'how much of the secret is stored recoverable' is the security property, the authoritative comment understates the token entropy and misstates the stored prefix.
- **fix:** Correct the docblock to `ccp_<48 hex chars>` and 'first 12 chars (ccp_ + 8 hex)'.

### S6-6 — Class-level @RateLimit(600/min) on /v1 controllers can never bind — the ApiKeyGuard caps every key at 60/min first
- **file:** apps/api/src/external/v1/external-v1.controller.ts:220
- **claim:** All 16 /v1 controllers declare class-level @RateLimit({ perMinute: 600 }) 'as a generous ceiling', but apiKeyBucket in api-key.guard.ts:41 enforces 60/min/key on every request before the interceptor runs, so the 600/min buckets are unreachable dead configuration (only decorators tighter than 60 have effect). The public docs correctly state 60/min per key, so behavior matches docs — the decorators just mislead maintainers into thinking reads allow 600.
- **fix:** Either drop the dead 600/min class decorators (letting the guard be the documented single cap) or raise the guard cap for reads and let the decorators meter — one authority, matching the docs page.

### U6-6 — bindGuestConversation hand-rolls its ticket.changed publish: no guest audience, no per-workspace mapping, no user co-targets, and a fabricated openTicketCount of 0
- **file:** apps/api/src/lib/tickets/shares.ts:473
- **claim:** Every other ticket writer goes through `publishTicketEvent`, which derives `sharedWithWorkspaceIds`, `ticketByWorkspace` and `notifyUserIds` (mutations.ts:1650-1743). `bindGuestConversation` calls `publishInTx` directly with none of those and with `openTicketCount: 0` hardcoded, even though the ticket usually has a real conversation whose count is readable via `bumpOpenTicketCount(tx, id, 0)` as the two sibling functions above it do (shares.ts:233, 334).
- **fix:** Replace the inline `publishInTx` with `publishTicketEvent(tx, { args: { workspaceId: ticket.workspaceId, actor, silent: true, skipOutboundWebhook: true }, ticket: t, openTicketCount: <real>, action: 'escalation_update', previousStatus: t.status })`, matching shareTicket/revokeTicketShare.

### U6-7 — A guest UNASSIGNING a `new` ticket silently promotes it to `open`
- **file:** apps/api/src/lib/tickets/mutations.ts:678
- **claim:** The owner branch nudges `new -> open` only for a truthy assignee (`if (args.assignedUserId && existing.status === 'new' && !statusMoves)`, line 674). The guest branch drops the truthiness test: `if (args.assignedUserId !== undefined && isGuest && existing.status === 'new' && !statusMoves) data.status = 'open';` — so a guest clearing their side's assignee is treated as 'the work is being done, by them'.
- **fix:** Mirror the owner guard: `if (args.assignedUserId && isGuest && existing.status === 'new' && !statusMoves)`.

### U6-8 — Attachment cap is a read-then-write, so concurrent uploads can exceed MAX_TICKET_ATTACHMENTS
- **file:** apps/api/src/lib/tickets/attachments.ts:85
- **claim:** `addTicketAttachment` reads `_count.attachments` before uploading the blob and creating the row (lines 75-87, 116-133); there is no unique constraint or CAS backing the ceiling, and `attachFiles` loops files sequentially with a fresh count read per file but no transaction spanning them.
- **fix:** Low-stakes: either accept and document it, or make the create conditional on a re-count inside the same transaction (and delete the just-uploaded blob on refusal, which the orphan sweeper would otherwise reclaim anyway).

### U6-9 — Stale docs and user-facing copy still describe the retired twin-pair escalation model
- **file:** prisma/schema.prisma:4348
- **claim:** CLAUDE.md §20 warns that a stale doc is worse than none because it is read as authority. Five places still describe the pre-2026-07-28 design: (a) prisma/schema.prisma:4348-4361 — the paragraph above `model TicketShare` says escalation 'creates a twin ticket over there (own number, own board card, own assignee, that workspace's own SLA)' and that state travels as 'MIRRORED TicketEvent rows', directly contradicting the correct block immediately below it; (b) apps/web/src/app/(app)/tickets/[id]/not-found.tsx — user-facing copy: 'an escalated ticket has its own twin (and its own number) on each side'; (c) packages/shared/src/events/types.ts — the `escalated` action doc says 'the target side sees an ordinary created' and `escalation_update` says 'The TWIN ticket in the other workspace changed'; (d) packages/shared/src/tickets/types.ts — `description` is documented as 'Set at creation, editable' although it is write-once (`cause_immutable`); (e) packages/shared/src/tickets/views.ts cites `apps/api/src/lib/tickets/views/where.ts`, a path that does not exist (the mapping lives in lib/tickets/views.ts).
- **fix:** Delete the superseded paragraph above `model TicketShare` (the correct one follows it), reword not-found.tsx to say a shared ticket keeps one id and is reachable from whichever workspace holds the share (the /locate 'switch and open' path already handles the real case), and correct the three shared-package docblocks.

### U5-5 — Tag usage count conflates saved-view references with contacts, and the UI presents the inflated number as a contact count
- **file:** apps/api/src/workspace-settings/tags/tags.service.ts:61
- **claim:** `TagsService.usage` starts from `_count.contacts` and then adds `+1` per saved view whose `filters.tagIds` names the tag (lines 45-64) — deliberately, to show the blast radius of a delete. But every consumer reads the number as contacts: the row badge is a Users icon linking to `/contacts?tag=<id>` with `title="View contacts tagged …"` (apps/web/src/features/settings/components/tags-settings.tsx:467-473), the page footer prints `{totalUsage} total contact-tag links` (:383), and the delete confirmation says `"${used} contacts currently carry this tag"` (:182). Same defect class as the U7-05 finding already logged in this program ("delete-contact dialog copy false").
- **fix:** Return the two counts separately — `{ contacts, views }` per tag id — and render them as distinct affordances (the people badge stays the contact count and keeps its link; a second chip reads "used by N views"). The delete dialog then names both consequences honestly.

### U5-6 — The message-flag definition catalog is the only unbounded workspace catalog, and every client refetches it in full on each change
- **file:** apps/api/src/workspace-settings/message-flags/message-flags-catalog.service.ts:79
- **claim:** `create()` performs no count check, unlike every sibling catalog: tags cap at 300 (apps/api/src/workspace-settings/tags/tags.service.ts:17, :88-94), snippets at 300 (snippets.service.ts:16, :62-68), stages at 30 (stages.service.ts:21, :77-82) and contact fields at 50 (contact-fields.service.ts:32, :140-145). The reasoning those caps record applies verbatim here: `list()` is unpaginated (lib/message-flags/queries.ts:270-281), it is SSR'd into every inbox render (apps/web/src/app/(app)/inbox/page.tsx:98) and re-pulled by every open tab on each `team.catalog_changed { scope: "message-flags" }` tick, which `use-catalog-sync.ts` does not narrow by pathname (SCOPE_AFFINITY has no entry for it, so it refreshes on every route).
- **fix:** Add `MAX_FLAG_DEFINITIONS_PER_WORKSPACE` with the same count-then-400 shape the tags/snippets services use, and mirror the `*_limit_reached` error key so the shared error-message helper renders it.

### U5-7 — Assignment-rule `channels` conditions are stored as free-text, not validated against LIVE_CHANNELS
- **file:** apps/api/src/assignment/assignment.schemas.ts:76
- **claim:** `RuleConditionsSchema.channels` is `z.array(z.string().min(1)).max(20)` while the equivalent inbox-view criterion uses `zLiveChannel()` (apps/api/src/inbox-views/inbox-views.schemas.ts:54), whose docblock explicitly says "use it for every request-level channel filter" and records that the free-text shape once let a bogus value permanently 500 the counts endpoint for a whole workspace (fix 1c548520). The blast radius here is smaller because `matchesConditions` fails closed on a non-matching value (apps/api/src/lib/assignment/rules.ts:60-63), so the rule silently never fires — but the settings UI then shows an enabled rule that provably does nothing, which is the failure mode the assignment service's own comments say they are avoiding ("a rule that can't resolve is a rule that silently does nothing, and silent is the enemy here", assignment.service.ts:283-285).
- **fix:** Swap `z.array(z.string().min(1)).max(20)` for `z.array(zLiveChannel()).max(20)`, matching the inbox-view criterion. Existing rows with dead values keep failing closed, so the change is additive.

### U5-8 — The views rail's filter summary cannot name accounts or deactivated teammates, so a view's tooltip degrades to "1 account" / "1 teammate"
- **file:** apps/web/src/features/inbox/components/views/inbox-views-section.tsx:69
- **claim:** `summarizeInboxViewFilters` resolves ids through an optional lookup and falls back to a bare count when an id is unresolved. The rail's `lookup` supplies stageNames / tagNames / userNames / channelLabels / fieldLabels / optionNames but no `accountNames` (lines 69-85), even though the builder dialog does supply it, and `userNames` is built from `teammates` — the ACTIVE-only list from the layout (apps/web/src/app/(app)/inbox/layout.tsx:76). So the rail and the builder describe the same view differently.
- **fix:** Pass `accountNames` into the rail's lookup from `useChannelAccounts()` (the same hook the builder uses at view-builder-dialog.tsx:120), and build `userNames` from the full `teamMembers` roster rather than the active-only `teammates` so a departed assignee still renders by name.

### U12-9 — AI side tables have no retention path at all — the automation-claim ledger grows one row per inbound message forever
- **file:** apps/api/src/lib/ai/automation-claim.ts:24
- **claim:** `ConversationAutomationClaim` is only ever created: the module has one `create` (:24) and one `findUnique` (:35), no delete exists anywhere in `apps/api/src`, and no sweeper in `lib/sweepers/` references the model — its only cleanup is the `onDelete: Cascade` from Workspace (schema.prisma:5852). The same is true of `AiAssistantInteraction`, `AiMessageMetadata` and `AiMessageTranscription`, none of which appear in any retention sweeper, while siblings like `OutboundEvent`, `ConversationEvent`, `WorkflowRun`, `Notification` and `ApiIdempotencyKey` all have one.
- **fix:** Add an `ai-retention` sweeper on the pattern of `notification-retention`: delete claims older than the redelivery window (days, not months) and age out interactions/metadata/transcriptions on a configurable horizon.

### U12-10 — The paid-STT attempt cap in the call-recordings sweeper is reset whenever a row falls outside the truncated candidate scan
- **file:** apps/api/src/lib/sweepers/call-recordings.ts:178
- **claim:** `selectRetriable` builds `liveIds` from the current scan only — `take: 50` on each of the two queries (:130, :160) — and then deletes every `lastAttemptAt` and `attemptCounts` entry whose id is not in that set (:178-183). `MAX_INAPP_ATTEMPTS = 3` exists precisely because "STT costs money" (:71-74), and `cappedOut` reads `attemptCounts`.
- **fix:** Prune the maps by age or on confirmed resolution (transcript written / horizon crossed), not by absence from a `take: 50` page.

### U12-11 — Operator mode is not stealth for team-chat typing, unlike the conversation typing handler
- **file:** apps/api/src/realtime/realtime.gateway.ts:1588
- **claim:** `typing:channel:start` checks the room membership and the token bucket but has no `client.data.isOperator` gate, while its conversation twin drops the frame outright at :1444 with a comment naming typing as "the strongest passive tell there is". CLAUDE.md §18 lists typing ("both team-facing and relayed to the customer") among the signals operator mode suppresses. The operator can reach a channel: `getDefaultChannel`'s primary branch (lib/team-chat/queries.ts:427) is not membership-filtered, so `/team` redirects them into #general, and `requireChannelMembership` short-circuits on `isDefault` (channel-guards.ts:58).
- **fix:** Add `if (client.data.isOperator === true) return;` to `onChannelTypingStart` (the matching stop no-ops on its own `typingInChannel.delete` gate, exactly as the conversation path relies on).

### U12-12 — Channel delete is the one team-chat write that drops workspaceId from its WHERE
- **file:** apps/api/src/team-chat/channels.service.ts:455
- **claim:** `remove` ends with `this.db.teamChannel.delete({ where: { id: channelId } })`, whereas the sibling `update` deliberately uses `updateMany` with `{ id: channelId, workspaceId }` and documents why (:415-418: "§18 wants workspaceId in every query's where clause"). The preceding `findFirst` (:439) scopes the row, so there is no live cross-tenant hole — this is the inconsistency, not an exploit.
- **fix:** `deleteMany({ where: { id: channelId, workspaceId } })` and treat `count === 0` as 404, mirroring `update`.

### U12-13 — answerCall's customer-service-window bump writes Contact without workspaceId in the where
- **file:** apps/api/src/calls/calls.service.ts:1875
- **claim:** `contact.updateMany({ where: { id: call.conversation.contactId, OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: answeredAt } }] } })` omits `workspaceId`, unlike every other write in this service (which carries it as documented defense-in-depth, e.g. :1767, :2248). The contactId comes from a workspace-scoped conversation read, so the row is correct today; the ingest twin (lib/providers/ingest-call.ts:687) has the identical omission.
- **fix:** Add `workspaceId: session.workspaceId` (and `workspaceId` in the ingest twin) to the where.

### U12-14 — validateMentions reads a channel row unscoped, concurrently with the membership guard it depends on
- **file:** apps/api/src/team-chat/channel-messages.service.ts:981
- **claim:** `validateMentions` resolves `isDefault` with `teamChannel.findUnique({ where: { id: channelId } })` — no workspaceId — and in `postMessage` (:183) and `postThreadReply` (:650) it is launched inside the same `Promise.all` as `requireChannelMembership`, so it issues that read before the guard has decided anything.
- **fix:** Scope the read (`findFirst({ where: { id: channelId, workspaceId } })`) and/or await `requireChannelMembership` before starting the mention validation.

### U12-15 — The stale-calls sweeper's predicate cannot use any Call index, so it seq-scans the table twice a minute
- **file:** apps/api/src/lib/sweepers/stale-calls.ts:95
- **claim:** Both scans filter on `{ status, ringingAt: { lt } }` with no workspaceId, while every Call index leads with workspaceId (`@@index([workspaceId, status, ringingAt desc])`, `@@index([workspaceId, ringingAt])`, schema.prisma:5505/5510). Postgres 16 has no index skip scan, so neither composite can serve the predicate and both queries fall back to a sequential scan. The header comment at :93 claims "the (workspaceId,status,ringingAt) index serves this filter", which is not what the planner can do.
- **fix:** Add a raw partial index on `(status, ringingAt)` WHERE status IN ('ringing','in_progress') in the hand-maintained 0_init section (plus its `partial-indexes.spec.ts` entry), or iterate tenants so the existing composite applies.

### U11-09 — `read:notes` is offered when minting a key but no route requires it, and /v1 has no note-read endpoint
- **file:** packages/shared/src/api-keys/scopes.ts:45
- **claim:** The scope enum ships `read:notes` and the key-creation UI advertises it as 'Read notes' (apps/web/src/features/settings/integrations/components/api-keys-manager.tsx:46) — unlike `write:users`, which the same map labels 'Legacy — grants nothing'. No /v1 route carries @RequireScope('read:notes') (check-v1-docs reports 22 scopes in use vs 25 in the enum: `*`, read:notes and write:users are unused), and there is no GET for internal notes at all — /v1 can create and delete a note but never read one back, while the inbox contact panel lists them. The checker's phantom-scope test only inspects the /docs/api page, which correctly omits read:notes from SCOPES, so nothing catches the UI's claim. This is the exact failure the checker documents for write:users: 'a partner mints a key from it and gets 403 with nothing to explain it'.
- **fix:** Either add GET /v1/conversations/:id/notes under @RequireScope('read:notes') (delegating to the same query the inbox panel uses) — which also closes the parity gap — or relabel read:notes in api-keys-manager.tsx the way write:users is labelled and add the retirement sentence to the docs page.

### U11-10 — Docs understate which routes require Idempotency-Key; POST /conversations/:id/call-button documents no requirement at all
- **file:** apps/web/src/app/docs/api/page.tsx:134
- **claim:** The Conventions block says the header is required by 'The send routes (POST /messages, POST /conversations/:id/messages, POST /conversations/:id/interactive)… Other mutations accept it optionally.' Ten routes actually call idemKeyRequired: those three plus /conversations/:id/messenger-template, /conversations/:id/call-permission, /conversations/:id/call-button, /contacts/import, /broadcasts, /broadcasts/:id/retry and /workflows/:id/trigger. Most are covered by their own endpoint prose, but the call-button entry (page.tsx:1105-1120) never mentions it — the only required-key route documented nowhere.
- **fix:** Add 'Requires an Idempotency-Key' to the call-button Endpoint and change the Conventions block to 'every route that sends a billed message, launches a campaign, fires a workflow or queues an import requires it — each such endpoint says so'.

### U11-11 — GET /v1/contacts?email= is non-deterministic when two contacts share an email
- **file:** apps/api/src/external/v1/external-v1.service.ts:716
- **claim:** The email natural-key branch does findMany({ where: {…, email insensitive}, take: 1 }) with no orderBy and no identityChannel scope. Email is not unique per workspace — a social/webchat contact can carry the same email as the WhatsApp contact (via the contact-share chip or widget pre-chat, which is exactly why the phone branch scopes to identityChannel:'whatsapp' and documents the determinism concern at lines 704-709). Without an ORDER BY, Postgres may return either row across calls.
- **fix:** Add a deterministic order (e.g. orderBy: [{ identityChannel: 'asc' }, { createdAt: 'asc' }]) and document which row wins, or mirror the phone branch's channel scoping.

### U11-12 — No cap on OutboundWebhook rows per workspace — every event fans out one delivery row + one BullMQ job per row
- **file:** apps/api/src/workspace-settings/outbound-webhooks/outbound-webhooks.service.ts:58
- **claim:** create() enforces url safety and event-type validity but never bounds how many webhooks a workspace may hold. The subscriber fans out to every matching row (subscriber.ts:352, 8 lanes) and each row costs a delivery INSERT plus a queued POST. /v1 create is admin:settings + 10/min and the internal route is admin-only, so this is a self-inflicted ceiling rather than a cross-tenant one — but the per-team delivery-slot gate (default 3) then starves that tenant's real deliveries.
- **fix:** Add a per-workspace count check in create() (e.g. 20) returning 400 too_many_webhooks, matching the caps already applied to tags/fields elsewhere.

### S12-5 — The workflow phone-target contact-create is the only create path that leaves stageId null
- **file:** apps/api/src/lib/workflows/steps/target.ts:324
- **claim:** Every other contact-create path resolves a default stage first: `contacts.service.ts:212` (`ensureDefaultStage` → :233/:258), `external-v1.service.ts:882`, `import-runner.ts:221`, `ingest.ts:2361`, `ingest.ts:3111`, `ingest.ts:3833`, `ingest-call.ts:166`. The workflow phone-target create at `target.ts:324-339` sets `workspaceId`, `identityChannel`, `phoneNumber`, `name` and `source` but no `stageId`, and the P2002 revive branch at :356-360 clears `deletedAt` and `source` without setting one either. The same block's own comment enumerates what it deliberately skips (events, `customerId` — reconciled by the 60s sweeper); the stage is not among them, and no sweeper backfills it.
- **fix:** Add `stageId: await ensureDefaultStage(workspaceId)` to the create at target.ts:324 (the helper is already imported across ingest and import-runner and is race-safe per lib/queries/stages.ts:103), and set it on the revive branch too when the revived row's stageId is null — mirroring what ingest's revive path does for other backfilled columns.

### S10-4 — Inbox global-search hook bypasses apiFetch: no BROWSER_API_BASE prefix and no 401 session-expiry guard
- **file:** apps/web/src/features/inbox/hooks/use-inbox-search.ts:91
- **claim:** Both fetches in this hook call the bare global `fetch` with a relative path — `fetch(url, { signal })` at :91 and `fetch(url)` at :128, where `url` starts with `/api/inbox/search`. Every other client read in the app goes through `apiFetch` / `fetchWithSessionGuard`, which (i) prefixes `BROWSER_API_BASE` (apps/web/src/lib/api/browser-base.ts) so the call reaches NestJS on :4000 in the cross-port dev topology, (ii) sends `credentials: "include"` so the Better Auth cookie survives that cross-origin hop, and (iii) routes a 401 through the session-expiry guard that redirects to /logout instead of leaving blank panels. This is the only client fetch in apps/web/src that does none of the three (verified by grep across the tree). In production the relative path works because Caddy fronts both processes, so the user-facing impact is limited to the expired-session path; in dev the whole tabbed inbox search silently returns nothing.
- **fix:** Replace both `fetch(...)` calls with `apiFetch(...)`; it accepts an `init` so the AbortController signal passes through unchanged.

### S10-5 — Inbox search loadMore is guarded on the query but not on the account narrow — changing the narrow mid-page appends results from the previous account
- **file:** apps/web/src/features/inbox/hooks/use-inbox-search.ts:130
- **claim:** `loadMore` captures `q` from `queryRef` and correctly discards a late page when the query has changed (:133). It does not do the same for `accountId`: `accountParam` is only a useCallback dependency, so an in-flight request created by the previous callback identity still resolves and still runs `setResults(prev => [...prev, ...page.items])` and `setNextCursor(page.nextCursor)`. The hook's own comment at :125-126 states the cursor was minted under a specific narrow and that mixing narrows skips/repeats rows — the first-page effect honours that (accountParam is in its deps and its AbortController cancels), but the load-more path does not.
- **fix:** Mirror the query guard: keep an `accountParamRef`, capture it alongside `q`, and bail in the `.then` when `accountParamRef.current !== capturedAccountParam`.

### S10-6 — Ticket notes and timeline are hard-truncated at 200/500 rows with no pagination and no UI hint that anything was dropped
- **file:** apps/api/src/lib/tickets/queries.ts:754
- **claim:** `listTicketNotes` takes the newest 200 (queries.ts:754-755) and `listTicketEvents` the newest 500 (:791-792), both newest-first then reversed, with no cursor parameter and no `hasMore` signal in the response. `ticket-detail-client.tsx` seeds `events`/`notes` from that response (:145-147) and its `reload({eventsOnly:true})` path (:199-213) wholesale replaces them; there is no cursor state and no load-older control. The ticket THREAD has the same 200 cap (apps/api/src/lib/tickets/thread.ts:45, :93) but at least explains itself in the UI (ticket-thread.tsx:98-112 documents the cap and frames the top of the loaded slice honestly). The caps are deliberate and documented in the code, and the newest rows are the ones kept, so this is a quality gap rather than a correctness bug — but CLAUDE.md §18 makes the audit log the answer to "who changed what", and on a long-lived escalated ticket the earliest part of that answer becomes unreachable through any surface, silently.
- **fix:** Cheapest honest fix: have both queries fetch `take + 1`, return a `truncated: true` flag in the detail envelope, and render a one-line "Older history not shown" marker at the top of the timeline/notes list. Full fix: add the same `{createdAt, id}` keyset cursor the thread and board already use and a load-older control.

### S4-11 — Workflow authoring (create / update / delete / test) is absent from /v1 with no stated reason
- **file:** apps/api/src/workspace-settings/workflows/workflows.controller.ts:57
- **claim:** The UI can create (`POST`), edit (`PATCH :id`), delete (`DELETE :id`) and dry-run (`POST :id/test`) a workflow. `/v1` exposes list, detail, runs, run detail, publish and manual trigger — six routes, no authoring. The docs section (page.tsx:2315-2325) frames the surface positively ("Read your automations, fire a manual one for a contact, and inspect what happened") and carefully justifies the read/publish/fire scope split, but never says that authoring is deliberately out or why. Publish IS exposed (page.tsx:2352-2359), which makes the omission read as an oversight rather than a decision: a key can turn a workflow live for the whole workspace but cannot see or change what it does.
- **fix:** Cheapest honest fix is one sentence in the Workflows section: authoring is in-app because a workflow graph is validated against the node cap, the step registry and the publish-time DAG checks, and a malformed graph posted by an integration is a runtime failure with no editor to fix it in. If authoring is wanted, `POST`/`PATCH`/`DELETE` under `admin:settings` reusing `WorkflowsService` is the shape.

### S4-12 — The documented `filters` field list for saved inbox views omits `channelAccountIds`, a supported per-account filter
- **file:** apps/web/src/app/docs/api/page.tsx:1455
- **claim:** The `POST /v1/inbox-views` block enumerates the filter document as "`statuses`, `assignee`, `channels`, `stageIds`, `tagIds` + `tagMatch`, `fields`, `hasOpenFlags`, `unreadOnly`". `channelAccountIds` is missing, yet it is a first-class field: declared in the shared type with a paragraph of rationale (`packages/shared/src/inbox-views/types.ts:76-88` — "A workspace running Sales and Support on two numbers wants a saved view per number far more than it wants one per channel"), validated by the very schema `/v1` uses (`apps/api/src/inbox-views/inbox-views.schemas.ts:58`), and implemented in the where-builder (`apps/api/src/lib/inbox-views/where.ts:77-79`). The route accepts it today (`external-v1-views.controller.ts:76-88` binds `CreateInboxViewSchema` directly).
- **fix:** Add `channelAccountIds` to the enumerated list with one line ("ChannelConnection ids from `GET /v1/channel-accounts`; a thread with no account never matches"), matching the type's own comment.

### S4-13 — Conventions card: three inaccuracies — the idempotency route list, the validation status code, and the flat rate limit
- **file:** apps/web/src/app/docs/api/page.tsx:135
- **claim:** (a) The Idempotency entry names three routes as requiring the header; the code requires it on ten — `POST contacts/import` (external-v1.controller.ts:332), `conversations/:id/messenger-template` (:874), `messages` (:1087), `conversations/:id/messages` (:1145), `conversations/:id/interactive` (:1195), `conversations/:id/call-permission` (:1530), `conversations/:id/call-button` (:1553, see S4-04), `broadcasts` (external-v1-broadcast-writes.controller.ts:70), `broadcasts/:id/retry` (:145) and `workflows/:id/trigger` (external-v1-workflows.controller.ts:87). Most are covered in their own sections, so the card is the outlier. (b) Line 160 lists "`422` validation" among common errors; Zod failures are `400` with `{ error: "invalid_body" | "invalid_query" | "invalid_params", issues }` (`apps/api/src/common/zod-validation.pipe.ts:33-47`) — 422 is used only for channel-capability refusals. The same line promises `{ error, detail }` for non-2xx, but validation errors carry `issues`, not `detail`. (c) Line 129 states a flat "60 req/min per key across all routes"; several routes are tightened well below it — 10/min on broadcast create, retry and analytics-refresh and on outbound-webhook create/rotate/test, 5/min on `contacts/export`, 20/min on `broadcasts/preview-missing` (`@RateLimit` decorators in the /v1 controllers). The import section does state its own limits (page.tsx:605, 627); the broadcast and webhook sections do not.
- **fix:** Card (a): replace the three-route enumeration with "every send and every irreversible write; each endpoint below says so" (or list all ten). (b): change `422 validation` to `400 invalid_body / invalid_query` and note that validation errors carry `issues` instead of `detail`; keep 422 described as a channel-capability refusal. (c): say 60/min is the per-key ceiling and that individual routes may be tighter, with the limit stated on the endpoint — then add the missing per-route numbers to the broadcast and outbound-webhook blocks the way the import block already does.

### S4-14 — The entire AI-assistant surface (20 routes across two controllers) has no /v1 presence and is not mentioned in the reference
- **file:** apps/api/src/ai-assistant/ai-inbox.controller.ts:41
- **claim:** Two live, module-registered controllers expose AI capabilities to the UI and nothing to `/v1`: `api/ai-assistant/*` (12 routes — conversation overview/summary, autopilot state, suggestion decision/audio/regenerate, per-customer memory read/update/delete, hallucination check, transcription read/update) and `api/workspace/ai-assistant/*` (8 routes — settings GET/PUT, voice preview, knowledge documents list/upload/reprocess/rename/delete). `/v1` exposes exactly one AI capability, `POST conversations/:id/ai` (the per-thread autopilot toggle, page.tsx:1159-1168), and the workspace-level toggles `PATCH /api/workspace/ai-autopilot` and `PATCH /api/workspace/ai-settings` (workspace-root.controller.ts:108,124) are likewise absent. The docs page never names the AI assistant, its settings, or its knowledge base. Under §12 this is the largest single undocumented block on the surface.
- **fix:** This is a scoping decision more than a bug: at minimum, add a short paragraph to the docs page stating which AI surfaces are in-app only and why (per-agent suggestion decisions have no agent identity behind a key; knowledge-document upload is multipart, same reasoning as ticket attachments at page.tsx:2007). If any part is to be exposed, workspace AI settings and the document list/upload/delete are the bounded ones, under `admin:settings`.

### TEN-02 — beyondMembershipFallbacks: API resolvers omit `deletingAt: null`, so a zero-membership org owner is 401'd while the web renders
- **file:** apps/api/src/auth/session.guard.ts:557
- **claim:** `resolveActiveWorkspaceId`'s last-resort `beyondMembershipFallbacks` is built three times. The API HTTP guard (`session.guard.ts:557-565`) and the socket handshake (`realtime/socket-auth.service.ts:284-292`) both do `workspace.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" }, take: 1 })` — no `deletingAt` filter. The web (`apps/web/src/lib/auth/current-user.ts:180`) reads from `loadActiveUser`'s pre-filtered list (`active-user.ts:63`: `workspaces: { where: { deletingAt: null }, orderBy: { createdAt: "asc" } }`). Because `makeCanAccessBeyondMembership` rejects any candidate with `deletingAt` set (`active-workspace.ts:179` and `:190`), the API's `take: 1` can hand the loop a single candidate that `canAccess` then refuses — and the loop ends with no second candidate to try. §18 names this exact file as the one where "three copies drifted once and the web silently rendered every switched session against the wrong workspace"; the copies have converged on the security-critical branches but diverge on this one.
- **fix:** Add `deletingAt: null` to the `where` in both API resolvers (`session.guard.ts:561` and `socket-auth.service.ts:288`) so all three callers select from the same candidate set. Consider raising `take: 1` to a small `take: 3` in all three so a single refused candidate is not fatal — `canAccess` is DB-verified and memoised per candidate, so extra candidates cost nothing and can only SELECT, never widen. Worth a line in `active-workspace.ts`'s header noting that the fallback LIST must already be filtered the same way `canAccess` filters, since the web's short-circuit at `current-user.ts:157-162` silently depends on that.

### TEN-03 — Operator-access entry accepts a workspace claimed for deletion, writing an audit row for an entry that then silently lands elsewhere
- **file:** apps/api/src/admin/admin-operator-access.controller.ts:88
- **claim:** `POST /api/admin/operator-access` resolves the target with `workspace.findFirst({ where: { id: body.workspaceId, organization: { isPlatform: false } } })` — no `deletingAt: null`. Both surfaces that answer the same question DO filter it: the workspaces list (`workspaces.service.ts:96`) and, decisively, `makeCanAccessBeyondMembership`'s superAdmin branch (`packages/shared/src/auth/active-workspace.ts:179`), whose own comment says "a workspace that has been claimed for deletion is mid-drain and must not become anyone's active workspace — a `ccp.ws` cookie pointing at it would otherwise resolve into an inbox whose rows are vanishing under it." The controller writes the append-only `OperatorAccess` row FIRST (deliberately — the record is the accountability, per §18), then stamps `Session.activeWorkspaceId` and sets the cookie. So the log records an entry the resolver will refuse.
- **fix:** Add `deletingAt: null` to the `where` at `admin-operator-access.controller.ts:89`, so the route 404s a mid-delete workspace exactly as the sibling admin controllers 404 the platform anchor. One clause; it makes the controller's precondition identical to the resolver's, which is the property the write-the-log-first ordering depends on to mean anything.

### TEN-04 — AiConversationState mutators take workspaceId and never put it in the where; ensureState returns a foreign row unchecked
- **file:** apps/api/src/lib/ai/conversation-state.ts:41
- **claim:** `AiConversationState` carries a `workspaceId` column (it is not in the TENANTLESS_ALLOWLIST). Every function in this file takes `workspaceId` as its first parameter and none of the 15 Prisma calls uses it in a `where` — all key on `conversationId` alone (`:41, :49, :57, :74, :87, :103, :117, :127, :138, :156, :183, :209, :218`). `ensureState(workspaceId, conversationId)` (:40) returns `existing` without comparing `existing.workspaceId` to the caller's, and only stamps `workspaceId` on the CREATE path. This is the "optional parameter nobody actually uses = dead control" shape the [[assignment-visibility-2026-07-21]] memory names as a bug class. It is not exploitable today — every caller (`ai-inbox.service.ts:158` via `assertConversation`, `ai-reply.subscriber.ts:173`, `orchestrator.ts:61`, `ingest.ts:2846`) resolves `conversationId` from a workspace-scoped read first — so this is a defense-in-depth gap against §7's literal rule, not a live leak.
- **fix:** Switch each mutator from `update({ where: { conversationId } })` to `updateMany({ where: { conversationId, workspaceId } })` and treat `count === 0` as a no-op (the same shape `messages.service.ts` and `broadcasts.service.ts` already use for exactly this reason — `channels.service.ts:415` even documents it: "updateMany (not update) so `workspaceId` can appear in the WHERE — `id` is the only unique, and §18 wants workspaceId in every query's where clause"). In `ensureState`, add `if (existing.workspaceId !== workspaceId) throw` (or return null) so a mismatched row is loud rather than silently adopted. Reads (`getState` :57) should take `workspaceId` and filter with `findFirst`.

### S13-05 — The displayed thread's LRU snapshot keeps a stale channelConnectionId after ingest re-stamps the thread's account, and the outbound-call panel reads the account from that snapshot
- **file:** apps/web/src/features/inbox/components/inbox-shell.tsx:1241
- **claim:** `initiateCallForActiveThread` resolves the call's channel and account from `cache.get(displayedId)` — `snapshot?.data.conversation.channel` and `snapshot?.data.conversation.channelConnectionId` (:1239-1241). For the DISPLAYED thread that snapshot is deliberately not patched by `message:new`: `evictIfBackground` returns early when `payload.conversationId === displayedIdRef.current` (:843), `message:new` is a REDUCER_EXCLUSION ("list mutation"), and the live hook — which does apply the re-stamped account at `use-conversation-events.ts:1473-1474` — writes back into the cache only on leave. So while the agent is looking at the thread, the LRU copy of `channelConnectionId` is whatever it was at open. The server re-resolves the sending account from the DB (the POST body carries only `sdp`), so this is display-only: `use-call.ts` puts the value straight into the optimistic `liveCall` panel state.
- **fix:** Read the account from the live thread state instead of the cache — pass the current `channelConnectionId` down from `ThreadWorkspace`/MessageThread's `data.conversation` into the call initiator, or have the shell keep a `displayedAccountIdRef` updated from the same `message:new` frame the live hook consumes.

### S13-06 — answerCall's customer-service-window bump writes Contact.lastInboundAt without workspaceId in the WHERE, against §7/§18 and against the file's own defense-in-depth convention
- **file:** apps/api/src/calls/calls.service.ts:1875
- **claim:** `await this.db.contact.updateMany({ where: { id: call.conversation.contactId, OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: answeredAt } }] }, data: { lastInboundAt: answeredAt } })` — no `workspaceId`. The same method's own CAS 40 lines above carries an explicit comment justifying the redundant tenant scope ("Defense-in-depth alongside the {id, workspaceId} gate above — a future refactor that drops the gate must not be one line away from a cross-tenant write"), and the sibling bump at :1615 does include `workspaceId`. The contactId is currently tenant-safe because `call` was loaded with `{ id: callId, workspaceId: session.workspaceId }`, so this is not a live cross-tenant write.
- **fix:** Add `workspaceId: session.workspaceId` to the where clause, matching :1615 and the CAS above.

### S13-07 — Meta data-deletion tombstones contacts across every workspace with no propagation at all
- **file:** apps/api/src/webhooks/meta/data-deletion.controller.ts:181
- **claim:** The verified data-deletion callback does `db.contact.updateMany({ where: { identityChannel: { in: ["messenger","instagram"] }, externalContactId: userId, deletedAt: null }, data: { deletedAt: new Date() } })` and then only logs. No `contact.deleted` / `contact.updated` event is published, so no `contact:deleted` frame reaches the contacts list (`contacts-client.tsx:424` is the only consumer) and no outbound webhook fires for a deletion the tenant is legally required to be able to evidence. The route legitimately has no tenant context (it matches across workspaces), which is why the omission is understandable — but the affected rows carry their own workspaceId and could be grouped.
- **fix:** Select `{ id, workspaceId }` for the matched rows before the update, then group by workspaceId and publish one `contact.deleted` per workspace (conversationIds: [] as the soft-delete path in contacts.service.ts:564-571 already does).

### S13-08 — user.profile_updated is published for the acting workspace only — a multi-workspace user's rename never reaches the sibling workspaces' member catalogs
- **file:** apps/api/src/users/users.service.ts:104
- **claim:** `updateMyProfile(workspaceId, userId, input)` publishes `{ type: "user.profile_updated", workspaceId, ... }` with the ACTING workspace only (same at :148 for the avatar upload), and the fanout rule (fanout-rules.ts:910) emits `team:catalog:changed{scope:"members"}` into that one workspace's meta room. A `User` belongs to one org but joins many workspaces via `WorkspaceMember`, and the members roster (assignment dropdown, contact-panel "assigned to", message-bubble sender names, mention picker) is per-workspace. `applyAvailability` (lib/availability/apply.ts:273-291) solves exactly this by looping `for (const workspaceId of workspaceIds)` and publishing one frame per workspace, with the comment "One frame per workspace: the payload is identical, but the room is not".
- **fix:** Load the user's `workspaceMemberships` and publish one `user.profile_updated` per workspaceId, mirroring lib/availability/apply.ts:273-291.

### S13-09 — Contacts and broadcasts lists have no socket-reconnect convergence — a network gap leaves rows stale with no repair path
- **file:** apps/web/src/features/contacts/components/contacts-client.tsx:423
- **claim:** `contacts-client.tsx` binds `contact:updated`, `contact:deleted` and `contacts:bulk_updated` (:423-425) but has no `socket.on("connect", ...)` and no `useSocketReconnect`. The only global reconnect refresh is in `use-catalog-sync.ts:136-145`, and it is deliberately gated on `reason === "io server disconnect"` (a server-forced kick) — an ordinary transport drop reconnects without any refresh. The broadcasts list is in the same position. Both differ from the inbox, ticket board, ticket detail, team-chat and inbox-views, which all refetch on `connect`.
- **fix:** Add `useSocketReconnect(() => router.refresh())` (debounced) to contacts-client and the broadcasts list, or relax the `io server disconnect` gate in use-catalog-sync to also refresh after any reconnect that followed a gap longer than the socket recovery window.
