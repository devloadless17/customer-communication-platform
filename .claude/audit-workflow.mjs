export const meta = {
  name: 'ultimate-production-audit',
  description: 'Exhaustive multi-agent production audit: ~40 domain reviewers + adversarial verification of every finding',
  whenToUse: 'Final pre-launch correctness/robustness/perf/security audit of the whole codebase',
  phases: [
    { title: 'Review', detail: '~40 independent domain reviewers read actual code and trace paths' },
    { title: 'Verify', detail: 'adversarial skeptics independently confirm/refute each finding' },
  ],
}

// ---------- schemas ----------
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['domain', 'summary', 'score', 'verifiedCorrect', 'findings'],
  properties: {
    domain: { type: 'string' },
    summary: { type: 'string', description: 'one-paragraph overall assessment of this domain' },
    score: { type: 'number', description: 'production-readiness score for this domain, 0..10' },
    verifiedCorrect: {
      type: 'array',
      items: { type: 'string' },
      description: 'concrete behaviors/paths you traced and confirmed correct & robust (be specific, cite files)',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'category', 'files', 'rootCause', 'impact', 'recommendedFix', 'blocksProduction', 'confidence'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          category: { type: 'string', description: 'correctness | race | security | data-integrity | perf | reliability | ui | ux | dead-code | maintainability' },
          files: { type: 'array', items: { type: 'string' }, description: 'file:line references you actually read' },
          rootCause: { type: 'string' },
          impact: { type: 'string' },
          recommendedFix: { type: 'string' },
          blocksProduction: { type: 'boolean' },
          confidence: { type: 'number', description: '0..1 your confidence this is a real issue' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'correctedSeverity', 'reasoning', 'evidence'],
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
    correctedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
    reasoning: { type: 'string', description: 'why, grounded in code you read' },
    evidence: { type: 'string', description: 'file:line you read to decide' },
  },
}

// ---------- shared preamble ----------
const PREAMBLE = [
  'You are a senior staff engineer performing the FINAL PRODUCTION AUDIT of a real SaaS app about to onboard paying customers.',
  'The repo root is the current working directory: a WhatsApp multi-agent shared inbox (think Front/Intercom for WhatsApp).',
  '',
  'STACK: Next.js (apps/web — RSC pages + Better Auth + frontend bundles) + NestJS (apps/api — HTTP controllers + Socket.io gateway + Meta webhook ingest + BullMQ workers + workflow engine) + PostgreSQL via Prisma + Redis/BullMQ + Socket.io.',
  'Meta WhatsApp Cloud API is the ONLY messaging provider. Framework-agnostic service code lives under apps/api/src/lib/ (NOT a root lib/). Shared types under packages/shared/src/.',
  'Client state is plain React (useState + pure reducers in apps/web/src/features/inbox/lib/thread-reducers.ts + small contexts) driven by Socket.io frames. NO Zustand, NO React Query.',
  '',
  'LOAD-BEARING ARCHITECTURAL RULES (a violation IS a finding):',
  '- Multi-tenancy: EVERY DB query must scope by teamId. A missing teamId filter on a read or write = cross-tenant data leak = CRITICAL.',
  '- Dedup: Meta delivers wamid at-least-once and retries non-200. Inbound MUST upsert / findUnique-gate on a unique externalId — never bare create. Concurrent duplicate webhooks must not double-insert.',
  '- Webhook auth: HMAC-SHA256 of the RAW request body via header X-Hub-Signature-256, timing-safe compare; reject bad/missing sig with 403. verify-token only at subscription setup.',
  '- Channel discriminator is Channel{whatsapp} on Conversation.channel / Message.channel / Contact.identityChannel / ChannelConnection.channel. There is NO "provider"/"vendor" column on rows.',
  '- One Conversation per (teamId, contactId), DB-enforced @@unique. Closed threads REOPEN, never fragment.',
  '- Realtime emit is in-process (Socket.io lives in NestJS). Inbox unread is TEAM-WIDE only (Conversation.unreadCount); markRead fires only when an agent is actually viewing (visible AND on the thread); every recovery path (live socket, delta backfill, full refetch on reconnect) must converge to server state.',
  '- Graceful shutdown in apps/api/src/main.ts is load-bearing: server.close() BEFORE app.close(); BullMQ worker.close() drains the in-flight job (lockDuration 90s) so jobs are not re-executed (irreversible Meta sends / tag changes double-fire otherwise).',
  '- Secrets (Team.metaAppSecret, TeamApiKey.secret) are envelope-encrypted; customer message bodies are intentionally NOT encrypted at rest (accepted).',
  '',
  'YOUR JOB: READ THE ACTUAL CODE in your assigned domain. Trace complete execution paths — happy AND failure. Verify behavior; do NOT trust comments, names, or CLAUDE.md claims. Hunt real defects: races, missing teamId scoping, dedup gaps, missing await, unhandled rejections, silent failures, data corruption, double-fires, event loops, N+1 queries, missing/ wrong indexes, auth/authz holes (IDOR), injection, SSRF, memory leaks, stale cache, reconnect/refresh bugs, optimistic-UI desync, UI flicker / layout shift, perf regressions, dead/duplicate code.',
  'Be concrete and skeptical. EVERY finding MUST cite file:line you actually opened. Prefer high-confidence findings over speculation, but do not miss real bugs. Also record, specifically, what you traced and VERIFIED CORRECT.',
  'Use Read/Grep/Bash freely. Return ONLY the structured object.',
].join('\n')

const PREAMBLE_VERIFY = [
  'You are an adversarial verifier on a production audit of a WhatsApp shared-inbox SaaS (Next.js + NestJS + Prisma/Postgres + Redis/BullMQ + Socket.io; Meta Cloud API only; service code under apps/api/src/lib/).',
  'Architecture rules that determine whether something is a real bug:',
  '- every query must scope by teamId (missing = cross-tenant leak); inbound webhooks must dedup on unique externalId; HMAC over raw body; one Conversation per (teamId,contactId); team-wide unread; in-process Socket.io emit; graceful shutdown drains BullMQ.',
  'A prior reviewer filed a finding. Re-investigate INDEPENDENTLY by opening the cited files (and surrounding context) yourself. Your default stance is SKEPTICAL: if you cannot concretely confirm the defect from the code, return "refuted" or "uncertain". Do not take the reviewer at their word; comments and names can lie.',
  'A finding can be real but mis-severed — set correctedSeverity to what the evidence supports. Cite the exact file:line you read.',
].join('\n')

function verifierPrompt(f, lens, d) {
  return [
    PREAMBLE_VERIFY,
    '',
    'DOMAIN: ' + d.label,
    'VERIFICATION LENS: ' + lens,
    '',
    'FINDING TITLE: ' + f.title,
    'CLAIMED SEVERITY: ' + f.severity + ' | category: ' + f.category + ' | blocksProduction: ' + f.blocksProduction,
    'FILES: ' + (f.files || []).join(', '),
    'CLAIMED ROOT CAUSE: ' + f.rootCause,
    'CLAIMED IMPACT: ' + f.impact,
    'PROPOSED FIX: ' + f.recommendedFix,
    '',
    'Decide: is this a REAL defect in the CURRENT code? Confirm ONLY if you can point to the exact code that exhibits it and no existing mechanism (guard, DB constraint, transaction, await, teamId scope, dedup, retry) already prevents it. Return the structured verdict.',
  ].join('\n')
}

// ---------- verdict reduction ----------
function reduceVerdicts(verdicts) {
  const v = (verdicts || []).filter(Boolean)
  if (!v.length) return { verdict: 'unverified', correctedSeverity: null, reasoning: 'no verifier returned', evidence: '' }
  const c = v.filter((x) => x.verdict === 'confirmed').length
  const r = v.filter((x) => x.verdict === 'refuted').length
  let verdict
  if (c > r) verdict = 'confirmed'
  else if (r > c) verdict = 'refuted'
  else verdict = 'uncertain'
  const order = ['info', 'low', 'medium', 'high', 'critical']
  const pool = v.filter((x) => x.verdict === 'confirmed')
  const usepool = pool.length ? pool : v
  let sev = null
  for (const x of usepool) {
    if (x.correctedSeverity && (sev === null || order.indexOf(x.correctedSeverity) > order.indexOf(sev))) sev = x.correctedSeverity
  }
  return {
    verdict,
    correctedSeverity: sev,
    reasoning: v.map((x) => x.verdict + ': ' + x.reasoning).join('  ||  '),
    evidence: v.map((x) => x.evidence).filter(Boolean).join('  ;  '),
  }
}

// ---------- domains ----------
const DOMAINS = [
  // ---- backend ----
  { key: 'schema-tenancy', label: 'Prisma schema, indexes & multi-tenancy scoping', focus:
    'DOMAIN: Database schema correctness + multi-tenancy. Read prisma/schema.prisma (2364 lines, 40 models). For EVERY model verify: teamId present & indexed; unique constraints correct (esp. Message externalId dedup unique, Conversation @@unique([teamId,contactId]), ChannelConnection @@unique([teamId,channel]), ApiIdempotencyKey); cascade/onDelete behavior cannot orphan or mass-delete wrongly; nullable columns that should not be; enum usage; @db types; JSON columns. THEN grep across apps/api/src for Prisma queries that read/write WITHOUT a teamId filter (findUnique by id only, updateMany/deleteMany without teamId, findMany without where teamId) — each is a potential cross-tenant IDOR. Check indexes back every hot query (conversation list, message thread pagination, contact search, unread counts). Report missing indexes that cause seq scans at scale.' },

  { key: 'migrations', label: 'Prisma migrations integrity', focus:
    'DOMAIN: prisma/migrations (32 migrations). Read them in order. Verify: no destructive column drops that lose data without a backfill; migration order is consistent with schema.prisma current state (no drift); unique indexes added concurrently/safely; defaults backfilled for NOT NULL added columns; the dedup unique on Message.externalId and Conversation @@unique([teamId,contactId]) exist and were added safely; migration_lock.toml provider. Flag any migration that would lock a large table or fail on existing prod data.' },

  { key: 'webhook-ingest', label: 'Meta inbound webhook ingest', focus:
    'DOMAIN: Inbound Meta webhook pipeline. Read apps/api/src/webhooks/** (incl. webhooks/meta/**) and the legacy proxy apps/web/src/app/api/webhooks/meta/[teamId]/route.ts. Trace: Meta POST -> HMAC verify guard -> provider.parse -> dedupe -> Prisma upsert -> publish domain event -> socket fanout. VERIFY: (1) HMAC computed over RAW bytes (not re-serialized JSON), timing-safe (crypto.timingSafeEqual), rejects missing/malformed sig 403; raw-body availability given NestJS bodyParser + correlation middleware ordering. (2) Dedup is upsert/findUnique on unique externalId; two concurrent identical webhooks cannot both insert (unique-violation caught). (3) raw_payload JSONB persisted. (4) 2-phase inbound media (placeholder row then async media fetch via sweeper) cannot lose a message, cannot cross teams, handles Meta media-fetch 401/404/timeout. (5) status webhooks (sent/delivered/read/failed) map correctly and cannot regress a higher status to a lower one. (6) returns 200 quickly; an internal error does not trigger infinite Meta retry storms nor drop the message. (7) unknown message types degrade gracefully. (8) teamId from URL validated against an existing ChannelConnection.' },

  { key: 'messaging-outbound', label: 'Outbound messaging (send text/media/template/interactive/forward)', focus:
    'DOMAIN: Outbound messaging. Read apps/api/src/messages/** and apps/api/src/lib/messaging/**, apps/api/src/lib/messages/**. Trace sendText/sendMedia/sendTemplate/sendInteractive/forward: validation -> 24h window check -> Meta API call -> persist Message(direction out, status, externalId from Meta response) -> publish message.sent -> socket fanout -> markReadOnAgentSend. VERIFY: (1) 24-hour customer-service-window enforcement (free-form blocked outside window, templates allowed); correct error to client. (2) OutboundSendAttempt / status lifecycle; failures persisted as status=failed, surfaced to UI, not silently dropped. (3) externalId (wamid) captured & unique; a Meta 200 with later failure webhook reconciles. (4) optimistic send + server reconcile cannot duplicate a message row. (5) teamId + conversation ownership enforced before send. (6) media send path (uploadthing/blob -> Meta media id) error handling. (7) rate-limit decorator on MessagesController; no quota multiplication across routes.' },

  { key: 'providers-meta', label: 'MessagingProvider abstraction & MetaProvider', focus:
    'DOMAIN: Provider layer. Read apps/api/src/lib/providers/** (6 files ~4625 loc) incl. MetaProvider, config/getProviderConfig/getProviderBinding, per-team secret resolution. VERIFY: (1) app code only talks to the MessagingProvider interface, never Meta shapes directly. (2) parse() normalizes every inbound shape (text, media, location, reaction, button/list reply, status, errors) without throwing on unexpected fields. (3) sendX methods handle Meta error envelopes, rate limits (429), token expiry, network timeouts; retries are bounded & idempotent. (4) getProviderConfig(teamId) reads env today but is structured for per-team columns; credential cache (Map) is correct & not a cross-tenant mixup. (5) phone-number normalization correctness. (6) no secret leakage into logs/errors returned to clients.' },

  { key: 'workflow-engine', label: 'Workflow engine core (worker, dispatcher, subscribers, run lifecycle)', focus:
    'DOMAIN: Workflow engine core. Read apps/api/src/workflows/** and apps/api/src/lib/workflows/** (worker service, dispatcher, subscribers, run lifecycle) plus the BullMQ wiring. VERIFY: (1) trigger dispatch fires a run exactly once per qualifying event — no duplicate runs on duplicate domain events; idempotency on (workflowId, triggerKey). (2) WorkflowRun state machine cannot get stuck or orphaned; crashes mid-run resume or fail cleanly (BullMQ retry + lockDuration 90s, drained on shutdown). (3) no infinite loops / recursive workflow self-trigger (a workflow action that emits an event the same workflow triggers on). (4) WorkflowAwaitingReply + WorkflowContactState lifecycle: waiting runs resume on the right inbound, time out, and cannot double-resume. (5) per-contact concurrency / state races. (6) cancellation & cleanup. (7) the waiting-sweeper and contact-drift sweeper interplay. Trace a full run end-to-end.' },

  { key: 'workflow-steps', label: 'Workflow steps & trigger/condition evaluation', focus:
    'DOMAIN: Workflow step types + condition/trigger evaluation. Read apps/api/src/lib/workflows/steps/** and the trigger/condition evaluators + packages/shared/src/workflows/events.ts + workflow-shapes.ts. VERIFY: (1) each step type (send message/template, tag add/remove, assign, set stage, set field, wait, branch/condition, webhook) executes correctly, is idempotent on retry, and persists progress so a re-run does not double-apply irreversible side effects (esp. Meta send, tag/stage mutation). (2) condition evaluation (string-equality only per design) handles missing fields, type coercion, null. (3) branch routing cannot drop a contact into a dead end or two branches at once. (4) template binding / field-token interpolation cannot inject or crash on missing tokens. (5) malformed/cyclic graph rejected at save or guarded at run.' },

  { key: 'broadcast-runner', label: 'Broadcast runner (bulk send)', focus:
    'DOMAIN: Broadcast runner. Read apps/api/src/lib/broadcast-runner.ts (1982 loc) + apps/api/src/broadcasts/** + apps/api/src/lib/broadcasts/**. VERIFY: (1) concurrency control — sends are throttled to respect Meta limits; no unbounded parallel fan-out. (2) BroadcastRecipient state machine: each recipient sent exactly once; a crash/restart mid-broadcast does not re-send to already-sent recipients (resumable / idempotent). (3) per-recipient failure isolation — one bad number does not abort the whole broadcast. (4) uses broadcast.recipient_message_sent / broadcast.conversation_reopened events (NOT message.sent) so analytics/audit are not bumped per recipient. (5) 24h-window + template correctness for cold sends. (6) memory: a 1k-10k recipient run does not hold unbounded state in process (CLAUDE.md flags 10k as the cliff). (7) reopen-conversation race when a recipient replies mid-broadcast.' },

  { key: 'event-bus', label: 'Event bus, subscribers & fanout', focus:
    'DOMAIN: Domain event bus. Read apps/api/src/lib/events/** + apps/api/src/events/** + packages/shared/src/events/types.ts + apps/api/src/realtime fanout subscriber. VERIFY: (1) every state mutation publishes exactly one DomainEvent; subscribers (socket fanout, audit, analytics, workflow dispatch, outbound webhooks) each react correctly. (2) suppressSocketFanout flag honored only by socket fanout (workflow/audit still fire) — and bulk paths emit one coalesced contact.bulk_updated. (3) no event can loop (subscriber publishes an event that re-triggers itself). (4) a throwing subscriber does not break other subscribers or the publishing request (error isolation). (5) broadcast.* events are excluded from analytics/audit by construction. (6) ordering guarantees the consumers rely on. (7) no event carries secrets or unbounded payloads.' },

  { key: 'realtime-gateway', label: 'Socket.io gateway, ws-adapter, rooms & recovery', focus:
    'DOMAIN: Realtime server. Read apps/api/src/realtime/** (gateway, ws-adapter, fanout service, ~2703 loc). VERIFY: (1) connection auth — socket handshake validates the Better Auth session cookie; an unauthenticated or cross-team socket cannot join a team/conversation room or receive frames (authz on join). (2) room membership: team room + per-conversation room correctness; a user only receives frames for their own team. (3) connection-state-recovery bounded at 30s (maxDisconnectionDuration) — confirm it is set and the reconnect contract matches the client. (4) no per-message DB query storm on fanout; emit is in-process. (5) backpressure / a slow client cannot block fanout. (6) presence accuracy. (7) cleanup on disconnect (no room/listener leak). (8) graceful shutdown closes sockets.' },

  { key: 'conversations-notes', label: 'Conversations service, notes & server-side read-state', focus:
    'DOMAIN: Conversations + internal notes + server read-state. Read apps/api/src/conversations/**, apps/api/src/notes/**, apps/api/src/lib/conversations/**, apps/api/src/lib/inbox/**. VERIFY: (1) status transitions (open/pending/closed) are valid; closing then inbound reopens the SAME conversation (the @@unique guarantees one per contact). (2) assignment changes attribute correctly and emit. (3) markRead server CAS publishes conversation.read ONLY on 1->0 transition (one-shot) and short-circuits already-read cheaply; cannot send redundant Meta read receipts. (4) internal notes never go to WhatsApp; author attribution; ordering. (5) ConversationEvent audit timeline is DB-only (no socket frame). (6) unreadCount increment/decrement cannot go negative or drift; concurrency on counter. (7) teamId scoping on every read/write.' },

  { key: 'contacts-backend', label: 'Contacts backend (CRUD, bulk, import, export, dedup)', focus:
    'DOMAIN: Contacts backend. Read apps/api/src/contacts/** (~2241 loc) + apps/api/src/lib/contacts if present. VERIFY: (1) contact identity is channel-scoped (phone+channel+team); creating a contact dedups on (teamId, identityChannel, phone) — no duplicate contacts on concurrent inbound + manual create. (2) bulk tag add/remove uses suppressSocketFanout + one contact.bulk_updated frame; bulk delete fires per-contact contact.deleted (intentional). (3) CSV import: malformed rows, huge files, phone normalization, partial failure handling, dedup against existing, memory bounds. (4) export streams / paginates (no load-all). (5) custom-field writes validate against ContactFieldDefinition; reserved fields protected. (6) search uses an index; not a full scan with ILIKE on every keystroke. (7) teamId scoping everywhere incl. lookup/count/preview.' },

  { key: 'sweepers', label: 'Background sweepers (18 files)', focus:
    'DOMAIN: Sweepers. Read apps/api/src/lib/sweepers/** (18 files ~2389 loc) incl. contact-last-inbound-drift, workflow-waiting, inbound-media. VERIFY: (1) each sweeper is idempotent and safe to run repeatedly; a partial failure mid-sweep does not corrupt or double-process. (2) scheduling: intervals correct, no overlapping runs (a slow sweep does not start a second concurrent pass). (3) self-disable / re-enable logic (drift sweeper disables after 7 days of zero drift, re-enables on restart) is correct. (4) inbound-media sweeper retries Meta media fetch with bounds and does not retry forever on permanent 404/410; updates the placeholder Message correctly; teamId scoping. (5) sweepers stop cleanly on shutdown (registered OnModuleDestroy in reverse-init order). (6) each query scopes by teamId or is global-by-design intentionally.' },

  { key: 'external-v1', label: 'External /v1 public API', focus:
    'DOMAIN: External /v1 API. Read apps/api/src/external/** (6 files ~4401 loc) incl. external/v1/** and apps/api/src/lib/external-shapes.ts. VERIFY: (1) ApiKeyGuard: key hashing/lookup constant-time, scopes enforced per-endpoint, per-key rate limiting, revoked keys rejected, teamId derived from the key (no teamId in body trusted). (2) idempotency: ApiIdempotencyKey honored — same Idempotency-Key returns the stored response, no double-send; key scoped per team+endpoint. (3) request validation (zod) on every endpoint; error envelopes consistent & documented; no internal detail/stack leakage. (4) UI->/v1 parity (locked rule) — endpoints behave like their internal counterparts. (5) pagination bounded; no unbounded list. (6) all 6 endpoints scope by teamId.' },

  { key: 'outbound-webhooks', label: 'Outbound webhooks (delivery, retries, signature, SSRF)', focus:
    'DOMAIN: Outbound webhooks. Read apps/api/src/outbound-webhooks/** + apps/api/src/lib/outbound-webhooks/** + packages/shared/src/outbound-webhooks/public-events.ts. VERIFY: (1) delivery via BullMQ with bounded retries + exponential backoff; a permanently-failing endpoint does not retry forever or block the queue. (2) HMAC signature on outbound payload so consumers can verify authenticity; secret per webhook. (3) SSRF protection — the target URL cannot point at internal/metadata IPs (169.254.169.254, localhost, RFC1918) ; safe-fetch / allowlist. (4) idempotency / delivery-chain depth guard (migration webhook_delivery_chain_depth) prevents a webhook that triggers an event that triggers the webhook (loop). (5) payload contains what consumers need and nothing sensitive (no secrets, no other teams data). (6) timeout on delivery; OutboundWebhookDelivery records status. (7) teamId scoping.' },

  { key: 'auth-authz', label: 'Auth, session guard, API-key guard & permissions', focus:
    'DOMAIN: AuthN/AuthZ. Read apps/api/src/auth/** (15 files), packages/shared/src/auth/** (permissions, password-policy, better-auth-config), apps/web/src/lib/auth/**, the session guard + api-key guard + permission decorators, LoginAttempt model usage. VERIFY: (1) session guard validates the Better Auth session_token cookie against the Session table, checks expiry, and binds req.session.team; cannot be spoofed. (2) authorization: admin-only routes (invites, users, workspace, teams, permissions) actually check role/permission; agents cannot escalate. (3) IDOR: every :id route checks the resource belongs to the caller team. (4) login throttling / LoginAttempt brute-force protection. (5) CSRF posture (sameSite cookie) for state-changing routes. (6) password policy + change-password (now on NestJS) correctness. (7) invite token: single-use, expiry, team binding. (8) registration flow cannot create cross-team or privilege-escalated users.' },

  { key: 'common-infra', label: 'Common infra: pipes, filters, correlation, rate-limit, bootstrap, shutdown', focus:
    'DOMAIN: Cross-cutting NestJS infra. Read apps/api/src/common/** (zod pipes, exception filter, rate-limit guard, correlation) + apps/api/src/main.ts (bootstrap + graceful shutdown) + apps/api/src/health/** + apps/api/src/app.module + db module. VERIFY: (1) graceful shutdown ordering (server.close + closeIdleConnections BEFORE app.close; ~3s flush; OnModuleDestroy reverse order; worker drain bounded by lockDuration; process.exit(0)) matches CLAUDE.md and is correct; SIGTERM/SIGINT both wired; not double-registered with enableShutdownHooks. (2) global exception filter does not leak stack/internal detail to clients and maps Prisma/zod errors to proper HTTP codes. (3) RateLimitGuard (300/min default, in-memory) correctness: bucketing per user, no-op without session, reset window, memory growth bound. (4) correlation ALS scope covers whole request (middleware first, before bodyParser). (5) zod pipes reuse schemas; reject + 400 cleanly. (6) health endpoint reflects real DB/redis health.' },

  { key: 'team-catalog', label: 'Team catalog CRUD (tags/stages/snippets/fields/audience/api-keys/whatsapp/templates)', focus:
    'DOMAIN: Team catalog REST. Read apps/api/src/team/** (43 files ~5447 loc): tags, stages, snippets, contact-fields, audience-groups, api-keys, whatsapp (settings+templates), permissions, outbound-webhooks, workflows sub. VERIFY for each resource: (1) teamId scoping on every CRUD op; no cross-team read/update/delete. (2) admin/permission gating where required. (3) validation (unique names, color formats, reserved field names, template variable shapes). (4) cascade behavior on delete (deleting a tag/stage/field used by contacts/workflows — orphan handling). (5) api-key creation returns the secret once and stores only a hash; whatsapp settings encrypt the app secret. (6) template create/sync against Meta handles approval status & errors. (7) no N+1 in list endpoints.' },

  { key: 'team-chat-backend', label: 'Team chat backend (channels, messages, mentions, reactions, pins, reads)', focus:
    'DOMAIN: Internal team chat backend. Read apps/api/src/team-chat/** + apps/api/src/lib/team-chat/** + packages/shared/src/team-chat/**. VERIFY: (1) channel membership authz — a non-member cannot read/post/react in a private channel; mentions only to members. (2) TeamChannelReadReceipt (per-user read state, distinct from inbox unread) correctness; unread counts cannot drift. (3) message ordering + threading + pagination. (4) reactions: one per (user,message,emoji) — no duplicate; toggle correctness. (5) pins, mentions notification fanout. (6) edit/delete authz (only author/admin) + tombstone. (7) teamId + channel scoping on every query; socket fanout only to channel members.' },

  { key: 'calls-backend', label: 'Calls backend (WhatsApp calling)', focus:
    'DOMAIN: Calls. Read apps/api/src/calls/** (~1601 loc) + Call / CallPermissionRequest models + packages/shared/src/providers/calling-regions.ts. VERIFY: (1) call lifecycle state machine (ringing/connecting/active/ended/failed) cannot get stuck; webhook-driven transitions are idempotent. (2) CallPermissionRequest flow correctness + expiry. (3) region/eligibility gating; CALLS_SKIP_PREFLIGHT env gotcha handled safely. (4) teamId + conversation scoping. (5) concurrency: two events for the same call cannot corrupt state. (6) any signaling secret handled safely. (7) failure paths surface to UI, not silently dropped.' },

  { key: 'crypto-secrets', label: 'Envelope crypto for secrets', focus:
    'DOMAIN: Credential encryption. Read apps/api/src/lib/crypto/** (2 files) + every call site (Team.metaAppSecret, TeamApiKey.secret, whatsapp settings, outbound webhook secret). VERIFY: (1) AEAD (e.g. AES-256-GCM) with per-record IV/nonce never reused; auth tag verified on decrypt. (2) master key sourced from env, validated at boot (fail-fast), never logged. (3) encrypt/decrypt symmetric and used at EVERY read/write of a secret (no plaintext leak path). (4) key rotation story / versioned envelope. (5) constant-time where comparing secrets/hashes. (6) decrypt failure handled (corrupt ciphertext) without crashing the request.' },

  { key: 'queries-perf', label: 'Query layer performance (N+1, pagination, indexes)', focus:
    'DOMAIN: Read-path performance. Read apps/api/src/lib/queries/** (10 files ~2739 loc) + heavy list endpoints (conversation list, message thread, contacts list, team-chat). VERIFY: (1) no N+1 — relations use include/select, not per-row queries in a loop. (2) pagination is keyset/cursor where lists are large (messages, contacts); no OFFSET on huge tables; bounded page size. (3) every WHERE/ORDER BY is index-backed (cross-check schema indexes). (4) counts (unread, totals) are not full-table aggregates on every request. (5) no over-fetching (select only needed columns; avoid pulling raw_payload JSONB into list views). (6) search queries bounded & indexed. Flag the top scaling cliffs.' },

  { key: 'media-blob', label: 'Media: blob storage, thumbnails, upload, inbound fetch', focus:
    'DOMAIN: Media pipeline. Read apps/api/src/lib/blob-storage/**, apps/api/src/lib/media/**, apps/api/src/media/**, apps/api/src/lib/media-storage.ts, media-thumbnail.ts. VERIFY: (1) upload (UploadThing single shared token today) — file-type/size validation, no arbitrary content type, no path traversal in keys; teamId prefixing for isolation (CLAUDE.md flags shared-token risk). (2) inbound media: 2-phase fetch from Meta, signed-URL handling, expiry, retry bounds, MIME sniffing. (3) thumbnail generation cannot OOM on a huge image/video; bounded. (4) signed URLs for display are scoped & expiring; a URL from team A cannot be guessed for team B. (5) audio/video/image/document all handled; corrupt media degrades gracefully. (6) no blocking sync I/O on the request thread.' },

  // ---- frontend ----
  { key: 'inbox-state', label: 'Inbox shell, list & client state (reducers, LRU cache)', focus:
    'DOMAIN: Inbox client state. Read apps/web/src/features/inbox/components/inbox-shell.tsx (1664), conversation-list.tsx (797), lib/thread-reducers.ts (511), contexts/**. VERIFY: (1) the realtime cache-patch matrix — every per-thread mutation (status/assignment/custom field/tag/note/unread) is wired in BOTH thread-reducers AND the inbox-shell cached-shell reducer AND useConversationEvents; a chat-switch + back must not revert a field to a stale snapshot. (2) LRU cache eviction on reconnect is correct; displayed thread is not evicted. (3) list badge clears via LOCAL conversation:read dispatch (not server frame). (4) reducers are pure; no mutation of state; no stale closures. (5) filters (All/Mine/Unassigned) + sort are consistent with server. (6) no unnecessary re-renders of the whole list on one conversation update (memoization, keys). (7) optimistic updates reconcile with server frames without flicker/duplication.' },

  { key: 'message-thread-render', label: 'Message thread rendering, ordering, virtualization, scroll', focus:
    'DOMAIN: Message thread render. Read apps/web/src/features/inbox/components/message-thread.tsx (1981), message-bubble.tsx (451), message-bubble/media-blocks.tsx (750), hooks/use-chat-scroll.ts (454). VERIFY: (1) message ordering is stable & correct (by timestamp then id tiebreak); out-of-order socket arrival re-sorts correctly; no duplicate bubbles on optimistic+server reconcile. (2) virtualization/windowing (or lack of) — a 5k-message thread renders without jank; scroll position preserved on prepend (load older) and pinned-to-bottom on new message only when already at bottom. (3) media blocks (image/audio/video/doc) lazy-load, correct aspect ratio (no layout shift), error fallback. (4) reply/quote rendering, reactions, status ticks correct. (5) no key warnings / index keys causing remount. (6) activity-log ordering (the documented vibration/messy-log bug class) intact. (7) date separators / grouping correct across tz.' },

  { key: 'reply-box', label: 'Reply box, media/voice/emoji/template send, 24h window', focus:
    'DOMAIN: Reply box. Read apps/web/src/features/inbox/components/reply-box.tsx (1737), reply-box/voice-recorder.tsx (486), reply-box/emoji-popover.tsx (426), template-picker/**, interactive-popover.tsx. VERIFY: (1) optimistic send -> server reconcile -> 30s watchdog -> failed/red state; rapid double-enter cannot send twice or duplicate; the watchdog cannot wrongly mark a delivered message failed. (2) 24h-window awareness — composer greys/disables for free-form when window expired, hints templates; cannot send a free-form into a closed window. (3) media upload progress, cancel, error; voice recorder cleanup (mic stream released, no leak) on unmount/cancel. (4) emoji + mention insertion preserves caret/IME. (5) template picker fills variables, validates required, no injection. (6) draft persistence per conversation; switching chats does not bleed a draft. (7) paste/drop attachments validated client-side.' },

  { key: 'conversation-events', label: 'use-conversation-events / use-team-events: reconnect & read convergence', focus:
    'DOMAIN: Inbox realtime client hooks. Read apps/web/src/features/inbox/hooks/use-conversation-events.ts (1726), use-team-events, use-chat-scroll, and the socket client setup. VERIFY (this is the documented stuck/wrong-unread bug class): (1) markRead fires only when visible AND on thread (mount on every visible mount, live onMessageNew gated on visibility else deferred, onVisibility fires deferred). (2) three recovery paths converge to server state: live socket reducers, delta backfill (?after=) on first connect, FULL refetch on real reconnect (notes/contact/status that changed offline). (3) connection-state-recovery 30s bound matches server; LRU evict on reconnect except displayed thread. (4) no double-subscribe / listener leak on conversation switch (cleanup deps). (5) hidden background tab parked on a thread does NOT clear team unread. (6) reconnect does not replay stale optimistic sends. (7) effect dependency arrays correct (no infinite refetch loop, no stale closure).' },

  { key: 'contact-panel', label: 'Contact panel & custom fields (realtime patch matrix)', focus:
    'DOMAIN: Contact panel. Read apps/web/src/features/inbox/components/contact-panel.tsx (1430). VERIFY: (1) editing a custom field / tag / stage / note optimistically updates and reconciles with the contact.updated socket frame without flicker or revert. (2) the field is wired into the realtime cache-patch matrix (both reducers + consumers) so a chat-switch + back does not show a stale value. (3) field validation client-side matches server ContactFieldDefinition; reserved fields read-only. (4) no unnecessary refetch of the whole contact on each keystroke; debounced save. (5) bulk contact.bulk_updated handled. (6) loading/empty/error states for the panel; no layout shift when data resolves.' },

  { key: 'team-chat-frontend', label: 'Team chat frontend', focus:
    'DOMAIN: Team chat UI. Read apps/web/src/features/team-chat/** (23 files ~6652 loc): components, hooks, contexts. VERIFY: (1) channel switch + reconnect convergence (there is a post-audit test team-chat-reconnect.spec) — read receipts, unread badges, messages converge to server after a drop. (2) optimistic message send reconciles; no duplicate; failed state. (3) mentions autocomplete, reactions toggle, pins, threads render & update in realtime without flicker. (4) read state per-user is correct and does not bleed across channels. (5) no listener leak on channel switch; memoized lists; virtualization for long channels. (6) typing indicators / presence accuracy. (7) loading/empty/error states; no layout shift.' },

  { key: 'workflows-frontend', label: 'Workflows frontend (React Flow canvas)', focus:
    'DOMAIN: Workflow builder UI. Read apps/web/src/features/workflows/** (13 files ~6762 loc): React Flow canvas, node editors, validation. VERIFY: (1) graph validation before save — disconnected nodes, cycles, missing required config, invalid trigger/condition — surfaced clearly; cannot save a malformed graph that crashes the engine. (2) node config forms validate (template tokens, field names, conditions) and match the backend step schema in packages/shared/src/workflow-shapes.ts. (3) canvas perf with many nodes (no re-render storm on drag); undo/redo or autosave consistency. (4) save/load round-trips the graph faithfully (no silent node/edge loss). (5) optimistic enable/disable toggle reconciles. (6) loading/error states; unsaved-changes guard.' },

  { key: 'contacts-frontend', label: 'Contacts frontend (list, import, bulk, search/filter)', focus:
    'DOMAIN: Contacts UI. Read apps/web/src/features/contacts/** (16 files ~3373 loc). VERIFY: (1) virtualization/pagination for large contact lists (no render-all). (2) CSV import wizard: column mapping, preview, validation, progress, partial-failure reporting, no UI freeze on a big file. (3) bulk select + tag/stage/delete uses the coalesced contact.bulk_updated frame; selection survives a realtime update; no O(n) refetch. (4) search/filter debounced, server-backed, indexed; no full client filter on huge sets. (5) custom-field columns render; sort stable. (6) optimistic edits reconcile; loading/empty/error states; no layout shift.' },

  { key: 'settings-ui', label: 'Settings, templates, broadcasts, calls, audience, tags UI', focus:
    'DOMAIN: Secondary feature UIs. Read apps/web/src/features/settings/** (2550), templates/** (1252), broadcasts/** (820), calls/** (1301), audience-groups/** (291), tags/** (343) and their app/(app)/settings pages. VERIFY: (1) each settings page (account, team, workspace, whatsapp, stages, tags, contact-fields, snippets, permissions, integrations, notifications, activity) validates input, shows save success/error, optimistic+reconcile, no silent failure. (2) broadcasts UI: audience selection, template fill, schedule, progress; cannot submit an invalid/cold broadcast without template. (3) templates UI: variable editor, approval-status display, sync. (4) calls UI permission flow. (5) consistent loading/empty/error states; no layout shift; forms disable on submit to prevent double-submit.' },

  { key: 'shared-ui', label: 'Shared UI primitives, hooks, providers, time/tz rendering', focus:
    'DOMAIN: Shared UI foundation. Read apps/web/src/components/** (39 files incl. ui/), apps/web/src/hooks/** (9), apps/web/src/providers/** (4), apps/web/src/lib/**. VERIFY: (1) time rendering single source of truth — useTzNow()/useNow() seeded from server Date.now so SSR and first client paint match (no "42h ago" flash); LocalTime absolute vs relative split; NO new useState(null)+useEffect(setNow) pattern. (2) providers (tz, socket, toast, theme) mount once, no remount storms, correct context boundaries. (3) shadcn ui primitives a11y (focus traps in modals, ARIA, keyboard nav, ESC to close). (4) loading/skeleton/empty/error components consistent. (5) hooks have correct deps, no leaks, cleanup. (6) no layout shift from late-loading fonts/images; reduced-motion respected for framer-motion. (7) error boundary coverage.' },

  { key: 'rsc-pages', label: 'RSC pages, layouts, auth pages, route protection', focus:
    'DOMAIN: Next.js app router. Read apps/web/src/app/** (103 files ~17657 loc): (platform), (app), login, register, invite, pending, logout, docs, layouts, middleware, instrumentation.ts. VERIFY: (1) route protection — every (app) page requires a valid session server-side; unauthenticated -> login; pending/role gating for (platform). (2) RSC data fetching scopes by the session team; no client-trusted teamId; no over-fetch in server components. (3) auth pages (login/register/invite/change-password) correctness, error states, redirect-after. (4) instrumentation.ts fail-fast env validation + NEXT_RUNTIME nodejs guard. (5) the legacy webhook proxy + /api/health + /api/auth catch-all are the only remaining app/api routes (deletion deadline 2026-06-19 for the proxy — flag it is PAST DUE). (6) layouts do not leak data across teams; loading.tsx/error.tsx present. (7) no client/server boundary mistakes (server-only imports in client comps).' },

  { key: 'packages-shared', label: 'Shared package (types, dtos, permissions, socket events, template render)', focus:
    'DOMAIN: packages/shared/src/** (27 files). VERIFY: (1) DTOs/types are the single source of truth shared by web + api; no drift between a zod schema and its TS type. (2) permissions.ts — the permission matrix is correct and complete; used consistently by both guard (api) and UI gating (web) so UI never shows an action the API rejects (and vice-versa). (3) socket/events.ts event names + payload types match what the gateway emits and the client listens for (a typo = a silently dropped frame). (4) template-render.ts / template-bindings.ts / field-tokens.ts interpolation cannot inject, handles missing tokens, escapes correctly. (5) phone/avatar/tag-color/window utils correctness (24h window math, phone normalization edge cases). (6) password-policy + better-auth-config consistent with server. (7) no server-only logic leaking into a browser-imported module.' },

  // ---- infra / quality ----
  { key: 'infra-deploy', label: 'Docker, Caddy, deploy scripts, heap & shutdown config', focus:
    'DOMAIN: Infra & deploy. Read docker-compose.yml (28k), docker-compose.local.yml, apps/*/Dockerfile, deploy/** (Caddyfile.template, README, scripts), .github/** CI, .dockerignore. VERIFY: (1) heap caps vs mem_limit — api NODE_OPTIONS=--max-old-space-size=2048 under mem_limit 3g; web 1536 under 2g; total commit fits 8GB box; rule heap <= ~75% mem_limit holds; no leftover 4096. (2) restart: unless-stopped on prod services; stop_grace_period 100s api / 30s web (>= BullMQ lockDuration 90s + tail); no leftover ccp systemd unit. (3) Caddy routing rules ordering: /api/auth/change-password -> NestJS BEFORE /api/auth/* -> Next; /api/webhooks/meta/* -> Next proxy; /api/* + /webhooks/* -> NestJS; WS upgrade. (4) RUN_WORKER_INLINE=1 on api; no stale Next-side flags. (5) secrets via env-file not baked into images; .dockerignore excludes .env. (6) healthchecks + depends_on ordering; postgres/redis resource limits. (7) Dockerfile multi-stage, non-root user, prisma engine present.' },

  { key: 'build-config', label: 'Build config: tsconfig, turbo, eslint, package scripts, prisma config', focus:
    'DOMAIN: Build & tooling. Read tsconfig*.json, packages/tsconfig/**, turbo.json, eslint.config.mjs, package.json (root + apps + packages), prisma.config.ts, pnpm-workspace.yaml, .nvmrc, scripts/**. VERIFY: (1) TypeScript strict mode on everywhere; no loosened compilerOptions hiding errors; @swc-node/register decorator metadata config for api (emitDecoratorMetadata + experimentalDecorators) and --conditions=react-server present in api:dev/start. (2) turbo pipeline caches typecheck/build correctly; no missing deps between tasks. (3) eslint config actually catches floating promises / no-unused / exhaustive-deps; count of eslint-disable (34) — are any masking real bugs. (4) pnpm-only enforced (corepack pin); no npm lockfile drift. (5) prisma.config loads .env relative to cwd correctly. (6) scripts (db:migrate, dev, typecheck) correct. Run `pnpm typecheck` if feasible and report failures.' },

  { key: 'code-quality', label: 'Whole-repo code quality sweep', focus:
    'DOMAIN: Code quality across the WHOLE repo. Use grep/bash. VERIFY/REPORT: (1) the 166 console.* calls — which are debug noise that should be a logger or removed vs intentional structured logs; any that log secrets/PII (phone numbers, tokens, message bodies, app secrets). (2) the 5 TODO/FIXME and 1 debugger/.only/.skip — locate and assess. (3) 19 `as any` and 55 @ts-ignore/@ts-expect-error — which mask real type bugs. (4) 34 eslint-disable — which suppress real issues. (5) dead code: exported-but-unused functions/components, unused files, commented-out blocks, obsolete abstractions left from the NestJS migration (deleted-route remnants). (6) duplicate logic across web/api that should share packages/shared. (7) inconsistent patterns. Be specific with file:line. Do NOT propose new features.' },

  // ---- cross-cutting hunters (independent cross-check of critical subsystems) ----
  { key: 'race-hunter', label: 'Cross-cutting concurrency & race hunter', focus:
    'DOMAIN: Concurrency/races across the ENTIRE system (independent cross-check — overlap with other agents is expected and wanted). Trace these specific race windows in actual code: (1) two concurrent identical Meta webhooks (dedup unique-violation handling). (2) optimistic client send + server persist + status webhook — can a message row duplicate or a status regress. (3) markRead CAS vs concurrent inbound increment — can unreadCount drift or go negative. (4) conversation close vs simultaneous inbound reopen (the @@unique race). (5) BullMQ job re-execution after a restart mid-job (workflow step / broadcast recipient double-apply). (6) sweeper overlap with live ingest writing the same Contact.lastInboundAt / media placeholder. (7) two agents assigning/closing the same conversation at once. (8) in-memory rate-limit / credential-cache Maps under concurrency. (9) idempotency-key check-then-write window in /v1. For each: does a DB constraint / transaction / atomic update / lock actually close the window? Cite code.' },

  { key: 'security-hunter', label: 'Cross-cutting security & IDOR hunter', focus:
    'DOMAIN: Security across the ENTIRE system (independent cross-check). Specifically hunt: (1) IDOR — every controller/route handler that takes an :id (conversation, message, contact, note, tag, broadcast, workflow, channel, api-key, webhook, call): does it filter by req.session.team / verify ownership before read/update/delete? List any that trust the id alone. (2) missing teamId on updateMany/deleteMany/findMany. (3) SSRF in outbound webhooks + any server-side fetch (media fetch, template sync) — internal IP / metadata endpoint reachable. (4) injection — raw SQL ($queryRaw), ILIKE search with unescaped input, template/field-token interpolation into Meta payloads. (5) secret exposure — secrets in logs, error responses, socket frames, /v1 responses, or client bundles (NEXT_PUBLIC_ misuse). (6) authz on socket join (cross-team room). (7) rate-limit gaps on auth + send + /v1. (8) file upload content-type/size/path. (9) CSRF on cookie-authed mutations. Cite exact code; prefer confirmed over theoretical.' },
]

// ---------- run ----------
// review one domain (with retry on transient null) then adversarially verify its findings
async function reviewDomain(d) {
  let res = null
  for (let attempt = 0; attempt < 3 && !res; attempt++) {
    res = await agent(PREAMBLE + '\n\n' + d.focus + '\n\nReturn the FINDINGS object for domain "' + d.label + '".', {
      label: 'review:' + d.key + (attempt ? ':retry' + attempt : ''),
      phase: 'Review',
      effort: 'high',
      schema: FINDINGS_SCHEMA,
    })
  }
  if (!res) return { domain: d.label, key: d.key, summary: 'REVIEW AGENT FAILED TO RETURN (transient API errors)', score: null, verifiedCorrect: [], findings: [] }
  const findings = res.findings || []
  const verified = await Promise.all(
    findings.map(async (f) => {
      const sev = f.severity
      if (!['critical', 'high', 'medium'].includes(sev)) {
        return Object.assign({}, f, { verification: { verdict: 'unverified', correctedSeverity: sev, reasoning: 'low/info severity — passed through without adversarial verification', evidence: '' } })
      }
      const lenses =
        sev === 'critical' || sev === 'high'
          ? [
              'REPRODUCE: walk the cited code line by line and show the exact execution path that triggers the defect. Confirm only if you can trace it.',
              'MITIGATION: search hard for any existing mechanism (DB unique/constraint, transaction, atomic update, await, teamId scope, dedup, guard, retry bound) that already prevents this. If one exists and works, REFUTE.',
            ]
          : ['Open the cited code and surrounding context; confirm only if the code concretely exhibits the issue, and judge whether the severity is right.']
      const verdicts = await parallel(
        lenses.map((lens) => () =>
          agent(verifierPrompt(f, lens, d), { label: 'verify:' + d.key, phase: 'Verify', schema: VERDICT_SCHEMA }),
        ),
      )
      return Object.assign({}, f, { verification: reduceVerdicts(verdicts) })
    }),
  )
  return { domain: d.label, key: d.key, summary: res.summary, score: res.score, verifiedCorrect: res.verifiedCorrect || [], findings: verified }
}

// Batched waves with a barrier between them: caps concurrent reviewers well under the
// runtime's 16-slot cap and spreads token throughput over wall-clock time, so we stay
// under the server-side request throttle that killed the un-batched first run.
const BATCH = 5
log('Auditing ' + DOMAINS.length + ' domains in waves of ' + BATCH + ' (paced to avoid the server throttle); each finding is adversarially verified.')
phase('Review')
const domainResults = []
for (let i = 0; i < DOMAINS.length; i += BATCH) {
  const chunk = DOMAINS.slice(i, i + BATCH)
  log('Wave ' + (Math.floor(i / BATCH) + 1) + '/' + Math.ceil(DOMAINS.length / BATCH) + ': ' + chunk.map((c) => c.key).join(', '))
  const chunkResults = await parallel(chunk.map((d) => () => reviewDomain(d)))
  for (const r of chunkResults) if (r) domainResults.push(r)
  log('Progress: ' + domainResults.length + '/' + DOMAINS.length + ' domains reviewed.')
}

// ---------- consolidate ----------
const domains = domainResults.filter(Boolean)
const allFindings = []
for (const dom of domains) {
  for (const f of dom.findings || []) {
    allFindings.push(Object.assign({}, f, { domain: dom.domain, domainKey: dom.key }))
  }
}
const ver = (f) => (f.verification && f.verification.verdict) || 'unverified'
const effSev = (f) => (f.verification && f.verification.correctedSeverity) || f.severity
const confirmed = allFindings.filter((f) => ver(f) === 'confirmed')
const uncertain = allFindings.filter((f) => ver(f) === 'uncertain')
const refuted = allFindings.filter((f) => ver(f) === 'refuted')
const passthrough = allFindings.filter((f) => ver(f) === 'unverified')
const bySev = (list) => ({
  critical: list.filter((f) => effSev(f) === 'critical').length,
  high: list.filter((f) => effSev(f) === 'high').length,
  medium: list.filter((f) => effSev(f) === 'medium').length,
  low: list.filter((f) => effSev(f) === 'low').length,
  info: list.filter((f) => effSev(f) === 'info').length,
})
const blockers = confirmed.filter((f) => f.blocksProduction || effSev(f) === 'critical')

log('Audit complete: ' + domains.length + ' domains, ' + allFindings.length + ' raw findings -> ' + confirmed.length + ' confirmed, ' + uncertain.length + ' uncertain, ' + refuted.length + ' refuted. Confirmed blockers: ' + blockers.length + '.')

return {
  stats: {
    domains: domains.length,
    rawFindings: allFindings.length,
    confirmed: confirmed.length,
    uncertain: uncertain.length,
    refuted: refuted.length,
    passthrough: passthrough.length,
    confirmedBySeverity: bySev(confirmed),
    uncertainBySeverity: bySev(uncertain),
    blockers: blockers.length,
  },
  confirmedFindings: confirmed,
  uncertainFindings: uncertain,
  refutedFindings: refuted.map((f) => ({ title: f.title, domain: f.domain, claimedSeverity: f.severity, why: f.verification && f.verification.reasoning })),
  passthroughFindings: passthrough,
  domainSummaries: domains.map((d) => ({ domain: d.domain, key: d.key, score: d.score, summary: d.summary, verifiedCorrect: d.verifiedCorrect })),
}
