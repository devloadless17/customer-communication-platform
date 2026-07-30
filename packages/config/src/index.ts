/**
 * Fail-fast environment validation, shared between the api and web processes.
 *
 * Categories of env var:
 *   - required:        missing → exit(1). The process physically can't function.
 *   - apiRequired:     required only in the api process (e.g. REDIS_URL — the
 *                      web process never connects to Redis; ENCRYPTION_KEY — only
 *                      the api decrypts). Missing in api → exit(1).
 *   - prodRequired:    missing in production → exit(1) in BOTH processes; warn
 *                      in development.
 *   - apiProdRequired: missing in production → exit(1), api process ONLY (e.g.
 *                      R2_* blob-storage creds — only the api reads/writes R2;
 *                      compose injects no R2 var into the web service).
 *   - webProdRequired: missing in production → exit(1), web process ONLY (e.g.
 *                      INTERNAL_API_URL — only the web process fetches the api).
 *   - recommended:     missing → warn in production. Boots but features degrade.
 *
 * Rationale: it's cheaper to crash at boot with a clear message than to start
 * up "successfully" and 500 on the first request that hits an unconfigured
 * subsystem. systemd will retry on Restart=on-failure; a tight loop with a
 * legible exit reason is a feature here, not a bug.
 *
 * Meta WhatsApp credentials are NOT validated here. CLAUDE.md rule #6 — they
 * live on the Team row, not in env vars. Send routes fail clearly when the
 * team hasn't been connected; no boot-time check would help.
 *
 * Called from:
 *   - apps/api/src/main.ts          (before NestFactory.create)
 *   - apps/web/instrumentation.ts   (Next.js boot hook, nodejs runtime only)
 */

const PROD = process.env.NODE_ENV === "production";

interface Check {
  /** Env var name. */
  name: string;
  /** Optional human description shown when the check fails. */
  hint?: string;
}

const required: Check[] = [
  {
    name: "DATABASE_URL",
    hint: "Postgres connection string. See .env.example.",
  },
  {
    name: "BETTER_AUTH_SECRET",
    hint:
      "Better Auth signing secret. Generate with: openssl rand -base64 32.",
  },
];

// Required only in the api process — the web process never connects to these.
// REDIS_URL: web serves RSC reads + Better Auth pages; BullMQ + Socket.io live
// in api. ENCRYPTION_KEY: every encryptSecret/decryptSecret call site lives in
// apps/api (per-team Meta credentials, API-key + webhook secrets). The web
// container never imports the envelope module, so injecting the master key
// there only widened the blast radius of a render-surface compromise — it now
// lives only where it's used.
const apiRequired: Check[] = [
  {
    name: "REDIS_URL",
    hint: "BullMQ broker (workflow + webhook queues). See docker-compose.yml.",
  },
  {
    name: "ENCRYPTION_KEY",
    hint:
      "AES-256-GCM key for envelope encryption of per-team Meta credentials " +
      "(ChannelConnection.secrets) + outbound-webhook + workflow secrets. Must " +
      "be base64 of 32 random bytes. Generate with: openssl rand -base64 32. " +
      "Rotating this without re-encrypting stored secrets breaks every team's " +
      "WhatsApp integration. api-only — the web process never decrypts.",
  },
];

const prodRequired: Check[] = [
  {
    name: "BETTER_AUTH_URL",
    hint:
      "Public URL of the app (https://your-domain). Better Auth uses it as the " +
      "default trusted origin for signin endpoints — must match the Caddy host.",
  },
  {
    name: "APP_PUBLIC_URL",
    hint: "Public URL embedded in outgoing webhook payloads (_links.*).",
  },
  {
    name: "INTERNAL_BUS_SECRET",
    hint:
      "Shared secret for cross-process internal RPCs between Next.js and " +
      "NestJS. Today used by /api/internal/session-invalidated (Next.js → " +
      "NestJS, on signout/deactivation to drop NestJS's session caches + " +
      "force-disconnect sockets). Same value MUST be set in both processes. " +
      "Generate with: openssl rand -base64 32.",
  },
  {
    name: "TRUSTED_PROXY_HOPS",
    hint:
      "Number of trusted reverse-proxy hops in front of the app (Caddy = 1). " +
      "Used by the rate limiter + IP detection to pick the correct " +
      "X-Forwarded-For entry. Wrong value silently breaks per-IP limiting " +
      "(either trusts spoofed IPs or collapses every request onto Caddy's " +
      "loopback bucket). Set to '1' for the default single-Caddy topology.",
  },
];

// Required in production, but ONLY in the api process. R2 blob storage is read
// exclusively by apps/api (media send/receive, avatar serving) — apps/web has
// zero R2/blob references, and docker-compose.yml deliberately injects no R2
// var into the web (app) service. Keeping these in prodRequired (BOTH
// processes) crash-loops the prod web container at boot. Mirrors webProdRequired
// but gated on label === "api".
const apiProdRequired: Check[] = [
  {
    name: "R2_ACCOUNT_ID",
    hint:
      "Cloudflare R2 account id (the <id> in <id>.r2.cloudflarestorage.com). " +
      "Part of the blob-storage credentials — without them EVERY inbound media " +
      "message is silently swallowed (the webhook records a text-only bubble " +
      "with no image; the agent never sees the customer's attachment).",
  },
  {
    name: "R2_ACCESS_KEY_ID",
    hint: "Cloudflare R2 S3 API access key id (Object Read & Write token).",
  },
  {
    name: "R2_SECRET_ACCESS_KEY",
    hint: "Cloudflare R2 S3 API secret access key.",
  },
  {
    name: "R2_BUCKET",
    hint: "R2 bucket name that stores all media + avatars (e.g. central-ccp).",
  },
  {
    name: "MAIL_FROM",
    hint:
      "The From address for verification codes + invites (e.g. " +
      "noreply@yourdomain.com). MUST be on a domain verified in Brevo with SPF " +
      "and DKIM DNS records — an unverified sender is either rejected outright " +
      "or delivered straight to spam, and no amount of application code fixes " +
      "that.",
  },
];

// Mail needs ONE of two credential sets, so neither can be individually
// required. Brevo issues an HTTP API key (`xkeysib-…`) and an SMTP key
// (`xsmtpsib-…`) and they are not interchangeable — pasting one where the other
// belongs fails with an error that names neither. `recommended` warns when
// BOTH are absent, which is the state that actually breaks signup + invites:
// with no credential the api LOGS every email instead of sending it, so nobody
// receives a verification code and both flows dead-end silently.
const mailRecommended: Check[] = [
  {
    name: "BREVO_API_KEY",
    hint:
      "Brevo HTTP API key (starts `xkeysib-`). Only needs outbound 443, " +
      "whereas SMTP needs port 587 open and fails as a HANG when it isn't. " +
      "Alternatively set MAIL_SMTP_HOST/USER/PASSWORD to send over the SMTP " +
      "relay with an `xsmtpsib-` key — preferred in production, because an " +
      "SMTP key can only SEND while a Brevo API key cannot be scoped and " +
      "grants full account access.",
  },
];

/**
 * Is outbound email actually configured?
 *
 * Mirrors `mailTransport()` in @ccp/shared/mail/send: HTTP when BREVO_API_KEY
 * is set, otherwise SMTP, otherwise a stub that writes the message to the log
 * and sends nothing.
 *
 * In production that stub is not a degraded mode, it is a broken product: a new
 * signup's verification code never arrives, and because the API refuses
 * unverified sessions the account can never be used. Password reset dies the
 * same way. So production BOOT FAILS rather than starting a deployment whose
 * only symptom is customers quietly unable to sign up.
 *
 * `MAIL_FROM` is checked alongside the credential because Brevo rejects a send
 * with no verified sender — having a valid key and no MAIL_FROM fails at the
 * first send instead of at boot, which is the same silent failure one step
 * later.
 */
function mailIsConfigured(): boolean {
  const hasTransport = Boolean(
    process.env.BREVO_API_KEY?.trim() || process.env.MAIL_SMTP_HOST?.trim(),
  );
  return hasTransport && Boolean(process.env.MAIL_FROM?.trim());
}

// Required in production, but ONLY in the web process (the api process never
// reads these). Mirrors apiRequired but gated on PROD like prodRequired.
const webProdRequired: Check[] = [
  {
    name: "INTERNAL_API_URL",
    hint:
      "Server-side target for the web process's RSC fetches + server actions " +
      "(apps/web → apps/api). The entire RSC/server-action data layer + the " +
      "legacy webhook proxy + the web health probe target it. Unset, it " +
      "silently falls back to a loopback that, inside the compose network, " +
      "points at the web container ITSELF → ECONNREFUSED on every page fetch. " +
      "Set to http://api:4000 in the standard compose topology. (api-side has " +
      "no use for it — this is web-only.)",
  },
];

const recommended: Check[] = [];

function present(c: Check): boolean {
  return Boolean(process.env[c.name]);
}

function describe(c: Check): string {
  return c.hint ? `${c.name} — ${c.hint}` : c.name;
}

/**
 * Validate environment. Returns void on success, exits the process on fatal
 * misconfiguration. Idempotent — safe to call multiple times (both api and
 * web call this on their respective boots).
 *
 * The `label` prefix is used in console output so the operator can tell
 * which process is shouting about a missing var when both boot at once.
 */
export function validateEnv(label: "api" | "web" = "api"): void {
  const tag = `[${label}:env]`;
  const missingRequired = required.filter((c) => !present(c));
  const missingApiRequired =
    label === "api" ? apiRequired.filter((c) => !present(c)) : [];
  const missingProdRequired = prodRequired.filter((c) => !present(c));
  const missingApiProdRequired =
    label === "api" ? apiProdRequired.filter((c) => !present(c)) : [];
  const missingWebProdRequired =
    label === "web" ? webProdRequired.filter((c) => !present(c)) : [];
  const missingRecommended = [
    ...recommended,
    // Mail is satisfied by EITHER transport, so it cannot be a plain per-var
    // check: warning about a missing API key while SMTP is happily configured
    // is the kind of noise that teaches operators to ignore boot warnings.
    ...(process.env.BREVO_API_KEY || process.env.MAIL_SMTP_HOST ? [] : mailRecommended),
  ].filter((c) => !present(c));

  const fatals = [
    ...missingRequired,
    ...missingApiRequired,
    ...(PROD ? missingProdRequired : []),
    ...(PROD ? missingApiProdRequired : []),
    ...(PROD ? missingWebProdRequired : []),
  ];

  // Mail is a production fatal, but it cannot be expressed as a per-variable
  // check: it is satisfied by EITHER credential group, so listing any single
  // name as required would be wrong in the other configuration.
  if (PROD && !mailIsConfigured()) {
    console.error(
      `${tag} fatal: outbound email is not configured. Set MAIL_FROM plus ` +
        `EITHER BREVO_API_KEY (HTTP, port 443) OR MAIL_SMTP_HOST/USER/PASSWORD ` +
        `(SMTP, port 587 — preferred in production: an SMTP key can only send, ` +
        `while a Brevo API key grants full account access).`,
    );
    console.error(
      `${tag} without it every email is written to the log and never sent, so ` +
        `no new account can complete verification and none can be used.`,
    );
    console.error(`${tag} aborting boot. Run \`pnpm mail:check\` to verify credentials.`);
    process.exit(1);
  }

  if (fatals.length > 0) {
    console.error(`${tag} fatal: missing required environment variable(s):`);
    for (const c of fatals) console.error(`  - ${describe(c)}`);
    console.error(`${tag} aborting boot. Set the variables above and restart.`);
    process.exit(1);
  }

  if (!PROD) {
    for (const c of [
      ...missingProdRequired,
      ...missingApiProdRequired,
      ...missingWebProdRequired,
    ]) {
      console.warn(`${tag} dev warning: ${describe(c)} (required in production)`);
    }
  }

  if (PROD && missingRecommended.length > 0) {
    for (const c of missingRecommended) {
      console.warn(`${tag} warning: ${describe(c)}`);
    }
  }

  // Sanity check on the public URL in prod — a localhost callback URL hitting
  // production is one of those bugs that only surfaces after a customer tries
  // to log in, by which point it's already embarrassing.
  if (PROD && process.env.BETTER_AUTH_URL?.includes("localhost")) {
    console.warn(
      `${tag} warning: BETTER_AUTH_URL points at localhost in production. ` +
        "Auth callbacks will fail for real users.",
    );
  }
  if (PROD && process.env.APP_PUBLIC_URL?.includes("localhost")) {
    console.warn(
      `${tag} warning: APP_PUBLIC_URL points at localhost in production. ` +
        "Outbound webhook _links.* payloads + workflow callbacks will be " +
        "unreachable from external systems.",
    );
  }

  // TRUSTED_PROXY_HOPS must parse as a positive integer. presence-only checks
  // above accept "abc" / "" / "0" — all of which silently degrade the rate
  // limiter or break per-IP detection without throwing. Fail boot loudly so
  // ops sees the typo before the first 4xx ratelimit storm.
  if (PROD) {
    const raw = process.env.TRUSTED_PROXY_HOPS;
    const parsed = raw === undefined ? NaN : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
      console.error(
        `${tag} fatal: TRUSTED_PROXY_HOPS must be an integer between 0 and 10, ` +
          `got ${JSON.stringify(raw)}. Set to '1' for the default single-Caddy topology.`,
      );
      process.exit(1);
    }
  }

  // ENCRYPTION_KEY shape check (api only). Presence is enforced above
  // (apiRequired), but the base64/32-byte shape is otherwise validated LAZILY
  // — loadKey() in envelope-core.ts only runs on the first encrypt/decrypt,
  // which is hours after boot and AFTER a green deploy. A truncated/typo'd key
  // therefore ships through CI smoke (which only polls health) and surfaces as
  // silently-403'd Meta webhooks / undecryptable credentials at first use.
  // Decode it here so a bad key crash-loops the api in smoke instead. Mirrors
  // KEY_BYTES=32 in envelope-core.ts.
  if (label === "api" && process.env.ENCRYPTION_KEY) {
    const decoded = Buffer.from(process.env.ENCRYPTION_KEY, "base64");
    if (decoded.length !== 32) {
      console.error(
        `${tag} fatal: ENCRYPTION_KEY must base64-decode to exactly 32 bytes ` +
          `(got ${decoded.length}). Regenerate with: openssl rand -base64 32.`,
      );
      process.exit(1);
    }
  }

  // META_GRAPH_VERSION shape check. The Meta provider builds URLs as
  // `https://graph.facebook.com/${META_GRAPH_VERSION}/...` — a typo like
  // "v25" (no `.0`) silently 404s every send until someone notices. The
  // default is "v26.0" if unset; only check when an operator overrides.
  if (label === "api" && process.env.META_GRAPH_VERSION) {
    const raw = process.env.META_GRAPH_VERSION;
    if (!/^v\d+\.\d+$/.test(raw)) {
      console.error(
        `${tag} fatal: META_GRAPH_VERSION must match v<major>.<minor> ` +
          `(e.g. "v26.0"). Got ${JSON.stringify(raw)}.`,
      );
      process.exit(1);
    }
  }

  // PLATFORM Meta app credentials, for the APP-LEVEL webhook callback
  // (`POST /webhooks/meta`, no workspaceId in the path).
  //
  // Optional until you are a Tech Provider: today every workspace brings its own
  // Meta app and its webhooks arrive on the per-workspace callback. Under Embedded
  // Signup all onboarded customers' webhooks go to the APP's callback URL, and
  // Meta's docs are explicit that template webhooks
  // (`message_template_status_update`, `_quality_update`, `_components_update`,
  // `template_category_update`) and account webhooks (`account_update`,
  // `account_review_update`, `account_alerts`) do NOT support
  // `override_callback_uri` — they are ALWAYS delivered there. So the app-level
  // route cannot be avoided by per-WABA overrides.
  //
  // `META_APP_SECRET` accepts a comma-separated list so a secret rotation can run
  // both values at once (same shape as the per-connection fallbacks).
  if (label === "api" && process.env.META_APP_ID) {
    if (!process.env.META_APP_SECRET) {
      console.error(
        `${tag} fatal: META_APP_ID is set but META_APP_SECRET is not. The app-level ` +
          `webhook route cannot verify a signature without it, and an unverified ` +
          `webhook route is an open ingest endpoint.`,
      );
      process.exit(1);
    }
    if (!process.env.META_APP_VERIFY_TOKEN) {
      console.error(
        `${tag} fatal: META_APP_ID is set but META_APP_VERIFY_TOKEN is not. Meta's ` +
          `GET verification handshake would fail and the callback could never be saved.`,
      );
      process.exit(1);
    }
  }

  // Numeric tunables (api process): validate-if-present. A typo like "5x"
  // silently becomes NaN downstream (NaN BullMQ concurrency, a server bound
  // to port 0, a sweeper that never fires), so fail loudly at boot instead.
  if (label === "api") {
    const positiveIntVars: Array<{ name: string; min: number; max: number }> = [
      { name: "API_PORT", min: 1, max: 65_535 },
      { name: "WORKFLOW_WORKER_CONCURRENCY", min: 1, max: 1000 },
      { name: "WORKFLOW_PER_TEAM_CONCURRENCY", min: 1, max: 1000 },
      { name: "WEBHOOK_WORKER_CONCURRENCY", min: 1, max: 1000 },
      { name: "WEBHOOK_DELIVERY_RETENTION_DAYS", min: 1, max: 3650 },
      { name: "WEBCHAT_VISITOR_RETENTION_DAYS", min: 1, max: 3650 },
      { name: "WEBHOOK_ORPHAN_GRACE_MS", min: 1000, max: 86_400_000 },
      // SigV4 presigned URLs cap at 7 days (604800s). Keep the default (3600)
      // unless a slow Meta broadcast-header fetch needs longer.
      { name: "R2_PRESIGN_TTL_SECONDS", min: 60, max: 604_800 },
    ];
    for (const v of positiveIntVars) {
      const raw = process.env[v.name];
      if (raw === undefined || raw === "") continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < v.min || n > v.max) {
        console.error(
          `${tag} fatal: ${v.name} must be an integer in [${v.min}, ${v.max}], ` +
            `got ${JSON.stringify(raw)}.`,
        );
        process.exit(1);
      }
    }
  }
}
