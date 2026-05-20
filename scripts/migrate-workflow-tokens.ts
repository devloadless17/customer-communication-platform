/* eslint-disable no-console */
/**
 * One-shot rewrite of saved workflow tokens to the canonical new
 * namespaces. The PR 2 resolver keeps the legacy 2-deep paths working
 * via backwards compat, but new authors who write to the inspector see
 * different tokens than what's stored in older workflows — surfaces an
 * inconsistency in audit logs / "why did this workflow paint differently"
 * UX. This migration brings every saved workflow onto the same canonical
 * shape so the legacy shim can be retired in a future release.
 *
 * Rewrites (all are aliases — semantics are unchanged):
 *
 *   $var.contact.X       → $var.trigger.contact.X
 *   $var.message.X       → $var.trigger.message.X
 *   $var.conversation.X  → $var.trigger.conversation.X
 *   $var.agent.X         → $var.trigger.agent.X
 *
 * NOT rewritten:
 *   - $var.sender.*       — already canonical
 *   - $var.previousStep.* — already canonical
 *   - $var.steps.*        — already canonical
 *   - $var.trigger.*      — already canonical (idempotent)
 *
 * Touches every node config string in every workflow's graph. Returns
 * the number of workflows modified so the operator can sanity-check.
 *
 *   Run:  pnpm tsx scripts/migrate-workflow-tokens.ts [--dry-run]
 *
 * Idempotent — running twice is a no-op (the legacy regex doesn't match
 * the rewritten tokens, since `trigger.` precedes them).
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env file (production runtime injects env vars directly) — fall
    // through; the Prisma client constructor will fail with a clearer
    // error than we can produce here.
  }
}

// Prisma 7 requires an adapter; pass the connection string directly to
// dodge the dual-`pg` install instanceof gotcha (see seed-superadmin.ts
// for the long explanation).
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const LEGACY_TO_CANONICAL: Array<{ legacy: RegExp; canonical: string }> = [
  // Order matters: more-specific replacements (sender / previousStep etc.)
  // aren't legacy so they don't appear; the four below are the only
  // 2-deep tokens whose canonical form ADDS a `trigger.` prefix.
  {
    // (?<![A-Za-z0-9_]) lookbehind matches the resolver's own boundary
    // rule — avoids rewriting `email$var.contact.X` and similar partial
    // matches in identifiers.
    legacy: /(?<![A-Za-z0-9_])\$var\.contact\./g,
    canonical: "$var.trigger.contact.",
  },
  {
    legacy: /(?<![A-Za-z0-9_])\$var\.message\./g,
    canonical: "$var.trigger.message.",
  },
  {
    legacy: /(?<![A-Za-z0-9_])\$var\.conversation\./g,
    canonical: "$var.trigger.conversation.",
  },
  {
    legacy: /(?<![A-Za-z0-9_])\$var\.agent\./g,
    canonical: "$var.trigger.agent.",
  },
];

/**
 * Walk an arbitrary JSON value and rewrite tokens in every string leaf.
 * Returns the rewritten value AND whether any change occurred.
 */
function rewriteJson(value: unknown): { value: unknown; mutated: boolean } {
  if (typeof value === "string") {
    let next = value;
    for (const { legacy, canonical } of LEGACY_TO_CANONICAL) {
      next = next.replace(legacy, canonical);
    }
    return { value: next, mutated: next !== value };
  }
  if (Array.isArray(value)) {
    let mutated = false;
    const out = value.map((item) => {
      const r = rewriteJson(item);
      if (r.mutated) mutated = true;
      return r.value;
    });
    return { value: out, mutated };
  }
  if (value && typeof value === "object") {
    let mutated = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = rewriteJson(v);
      if (r.mutated) mutated = true;
      out[k] = r.value;
    }
    return { value: out, mutated };
  }
  return { value, mutated: false };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  console.log(
    `[migrate-workflow-tokens] starting ${dryRun ? "(DRY RUN)" : ""}`,
  );

  const workflows = await db.workflow.findMany({
    select: { id: true, name: true, graph: true },
  });
  console.log(`[migrate-workflow-tokens] scanning ${workflows.length} workflow(s)`);

  let mutatedCount = 0;
  let totalReplacements = 0;
  for (const wf of workflows) {
    const before = JSON.stringify(wf.graph ?? {});
    const { value: nextGraph, mutated } = rewriteJson(wf.graph ?? {});
    if (!mutated) continue;
    const after = JSON.stringify(nextGraph);
    // Cheap "how many tokens changed" — count net `$var.trigger.` occurrences
    // gained in the after string. Useful as a sanity check.
    const beforeTriggerCount = (before.match(/\$var\.trigger\./g) ?? []).length;
    const afterTriggerCount = (after.match(/\$var\.trigger\./g) ?? []).length;
    const delta = afterTriggerCount - beforeTriggerCount;
    totalReplacements += delta;
    mutatedCount += 1;
    console.log(
      `  • ${wf.name} (${wf.id}) — ${delta} token(s) rewritten`,
    );
    if (!dryRun) {
      await db.workflow.update({
        where: { id: wf.id },
        // The graph column is typed Json — the rewritten value is JSON-safe
        // (we only ever touched string leaves), so the cast is sound.
        data: { graph: nextGraph as never },
      });
    }
  }

  console.log(
    `[migrate-workflow-tokens] done — ${mutatedCount} workflow(s), ${totalReplacements} token(s) rewritten${dryRun ? " (dry run, no DB writes)" : ""}`,
  );
  await db.$disconnect();
}

main().catch((err) => {
  console.error("[migrate-workflow-tokens] failed:", err);
  process.exitCode = 1;
});
