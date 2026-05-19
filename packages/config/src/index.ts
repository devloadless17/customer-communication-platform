/**
 * Fail-fast environment validation, shared between the api and web processes.
 *
 * Three categories of env var:
 *   - required:    missing → exit(1). The process physically can't function.
 *   - prodRequired: missing in production → exit(1); warn in development.
 *   - recommended: missing → warn in production. Boots but features degrade.
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
    name: "REDIS_URL",
    hint: "BullMQ broker (workflow queue). See docker-compose.yml.",
  },
  {
    name: "BETTER_AUTH_SECRET",
    hint:
      "Better Auth signing secret. Generate with: openssl rand -base64 32.",
  },
  {
    name: "ENCRYPTION_KEY",
    hint:
      "AES-256-GCM key for envelope encryption of per-team Meta secrets " +
      "(accessToken, appSecret). Must be base64 of 32 random bytes. " +
      "Generate with: openssl rand -base64 32. Rotating this without " +
      "re-encrypting Team rows breaks every team's WhatsApp integration.",
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
      "Shared secret for the cross-process cache-revalidate bridge. NestJS " +
      "calls /api/internal/revalidate on Next.js when catalogs mutate; this " +
      "endpoint requires the same value. Generate with: openssl rand -base64 32.",
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
  {
    name: "UPLOADTHING_TOKEN",
    hint:
      "Blob storage token. Without it EVERY inbound media message is silently " +
      "swallowed (the webhook records a text-only bubble with no image — the " +
      "agent never sees the customer's attachment). Promoted to prodRequired " +
      "after that exact failure mode shipped on a prior misconfiguration.",
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
  const missingProdRequired = prodRequired.filter((c) => !present(c));
  const missingRecommended = recommended.filter((c) => !present(c));

  const fatals = [
    ...missingRequired,
    ...(PROD ? missingProdRequired : []),
  ];

  if (fatals.length > 0) {
    console.error(`${tag} fatal: missing required environment variable(s):`);
    for (const c of fatals) console.error(`  - ${describe(c)}`);
    console.error(`${tag} aborting boot. Set the variables above and restart.`);
    process.exit(1);
  }

  if (!PROD && missingProdRequired.length > 0) {
    for (const c of missingProdRequired) {
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

  // META_GRAPH_VERSION shape check. The Meta provider builds URLs as
  // `https://graph.facebook.com/${META_GRAPH_VERSION}/...` — a typo like
  // "v25" (no `.0`) silently 404s every send until someone notices. The
  // default is "v25.0" if unset; only check when an operator overrides.
  if (label === "api" && process.env.META_GRAPH_VERSION) {
    const raw = process.env.META_GRAPH_VERSION;
    if (!/^v\d+\.\d+$/.test(raw)) {
      console.error(
        `${tag} fatal: META_GRAPH_VERSION must match v<major>.<minor> ` +
          `(e.g. "v25.0"). Got ${JSON.stringify(raw)}.`,
      );
      process.exit(1);
    }
  }
}
