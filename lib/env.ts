/**
 * Fail-fast environment validation. Runs once at boot from server.ts.
 *
 * Three categories:
 *   - required:    missing → exit(1). The app physically can't function.
 *   - prodRequired: missing in production → exit(1); warn in development.
 *   - recommended: missing → warn in production. App boots but features degrade.
 *
 * Rationale: it's cheaper to crash at boot with a clear message than to start
 * up "successfully" and 500 on the first request that hits an unconfigured
 * subsystem. systemd will retry on Restart=on-failure; a tight loop with a
 * legible exit reason is a feature here, not a bug.
 *
 * Meta WhatsApp credentials are NOT validated here. CLAUDE.md rule #6 — they
 * live on the Team row, not in env vars. Send routes fail clearly when the
 * team hasn't been connected; no boot-time check would help.
 */

const PROD = process.env.NODE_ENV === "production";

interface Check {
  /** Env var name. */
  name: string;
  /** Optional human description shown when the check fails. */
  hint?: string;
  /** Fallback that satisfies this check (e.g. NEXTAUTH_SECRET when AUTH_SECRET is missing). */
  fallbackVar?: string;
}

const required: Check[] = [
  {
    name: "DATABASE_URL",
    hint: "Postgres connection string. See .env.example.",
  },
  {
    name: "REDIS_URL",
    hint: "BullMQ broker (automations queue). See docker-compose.yml.",
  },
  {
    name: "AUTH_SECRET",
    fallbackVar: "NEXTAUTH_SECRET",
    hint:
      "NextAuth signing secret. Generate with: openssl rand -base64 32. " +
      "Set both AUTH_SECRET and NEXTAUTH_SECRET to the same value.",
  },
];

const prodRequired: Check[] = [
  {
    name: "NEXTAUTH_URL",
    hint: "Public URL of the app (https://your-domain). NextAuth uses it to sign callbacks.",
  },
  {
    name: "APP_PUBLIC_URL",
    hint: "Public URL embedded in outgoing automation webhooks (_links.*).",
  },
];

const recommended: Check[] = [
  {
    name: "UPLOADTHING_TOKEN",
    hint:
      "Blob storage token. Without it, every inbound/outbound media upload " +
      "will throw at first use. App boots, but media flows are broken.",
  },
];

function present(c: Check): boolean {
  if (process.env[c.name]) return true;
  if (c.fallbackVar && process.env[c.fallbackVar]) return true;
  return false;
}

function describe(c: Check): string {
  const both = c.fallbackVar ? `${c.name} (or ${c.fallbackVar})` : c.name;
  return c.hint ? `${both} — ${c.hint}` : both;
}

/**
 * Validate environment. Returns void on success, exits the process on
 * fatal misconfiguration. Idempotent — safe to call multiple times.
 */
export function validateEnv(): void {
  const missingRequired = required.filter((c) => !present(c));
  const missingProdRequired = prodRequired.filter((c) => !present(c));
  const missingRecommended = recommended.filter((c) => !present(c));

  const fatals = [
    ...missingRequired,
    ...(PROD ? missingProdRequired : []),
  ];

  if (fatals.length > 0) {
    console.error("[env] fatal: missing required environment variable(s):");
    for (const c of fatals) console.error(`  - ${describe(c)}`);
    console.error("[env] aborting boot. Set the variables above and restart.");
    process.exit(1);
  }

  if (!PROD && missingProdRequired.length > 0) {
    for (const c of missingProdRequired) {
      console.warn(`[env] dev warning: ${describe(c)} (required in production)`);
    }
  }

  if (PROD && missingRecommended.length > 0) {
    for (const c of missingRecommended) {
      console.warn(`[env] warning: ${describe(c)}`);
    }
  }

  // Sanity check on the public URL in prod — a localhost callback URL hitting
  // production is one of those bugs that only surfaces after a customer tries
  // to log in, by which point it's already embarrassing.
  if (PROD && process.env.NEXTAUTH_URL?.includes("localhost")) {
    console.warn(
      "[env] warning: NEXTAUTH_URL points at localhost in production. " +
        "Auth callbacks will fail for real users.",
    );
  }
}
