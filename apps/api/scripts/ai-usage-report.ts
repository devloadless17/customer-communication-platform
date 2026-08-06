/**
 * Read the AI usage ledger and say what it cost.
 *
 *   docker compose exec api node -r @swc-node/register \
 *     apps/api/scripts/ai-usage-report.ts [--days 7] [--by op|model|workspace|day]
 *
 * Locally, against a copy of the file:
 *   AI_USAGE_LOG=./ai-usage.jsonl pnpm --filter @ccp/api exec tsx \
 *     scripts/ai-usage-report.ts --days 30 --by model
 *
 * The ledger is JSONL, so nothing here is privileged — `jq` does the same job.
 * This exists so the common question ("what did last week cost, and on what")
 * has an answer that does not require remembering the field names.
 *
 * Lines with a null cost are counted and reported separately rather than summed
 * as zero: TTS bills audio-output tokens the API does not report, so a report
 * that quietly treated them as free would understate every voice workspace.
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";

interface Row {
  at: string;
  op: string;
  model: string;
  workspaceId: string | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  audioSeconds: number | null;
  costUsd: number | null;
  ok: boolean;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

interface Bucket {
  calls: number;
  cost: number;
  unpriced: number;
  input: number;
  cached: number;
  output: number;
  failed: number;
}

function empty(): Bucket {
  return { calls: 0, cost: 0, unpriced: 0, input: 0, cached: 0, output: 0, failed: 0 };
}

async function main(): Promise<void> {
  const path = process.env.AI_USAGE_LOG?.trim() || "/var/log/ccp/ai-usage.jsonl";
  if (!existsSync(path)) {
    console.error(`no ledger at ${path} — is AI_USAGE_LOG set on the api container?`);
    process.exit(1);
  }
  const days = Number(arg("days", "7"));
  const by = arg("by", "op") as "op" | "model" | "workspace" | "day";
  const since = Date.now() - days * 86_400_000;

  const buckets = new Map<string, Bucket>();
  const total = empty();

  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r: Row;
    try {
      r = JSON.parse(line) as Row;
    } catch {
      continue; // a torn last line from a crash mid-append; skip it
    }
    if (Date.parse(r.at) < since) continue;

    const key =
      by === "model" ? r.model
      : by === "workspace" ? (r.workspaceId ?? "(unattributed)")
      : by === "day" ? r.at.slice(0, 10)
      : r.op;

    const b = buckets.get(key) ?? empty();
    for (const t of [b, total]) {
      t.calls++;
      if (r.costUsd === null) t.unpriced++;
      else t.cost += r.costUsd;
      t.input += r.inputTokens ?? 0;
      t.cached += r.cachedTokens ?? 0;
      t.output += r.outputTokens ?? 0;
      if (!r.ok) t.failed++;
    }
    buckets.set(key, b);
  }

  if (total.calls === 0) {
    console.log(`no calls in the last ${days} day(s).`);
    return;
  }

  const rows = [...buckets.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const w = Math.max(12, ...rows.map(([k]) => k.length));
  console.log(`\nAI usage — last ${days} day(s), by ${by}   (${path})\n`);
  console.log(
    `${"".padEnd(w)}  ${"calls".padStart(7)}  ${"cost USD".padStart(10)}  ${"in".padStart(10)}  ${"cached".padStart(10)}  ${"out".padStart(10)}`,
  );
  for (const [k, b] of rows) {
    console.log(
      `${k.padEnd(w)}  ${String(b.calls).padStart(7)}  ${b.cost.toFixed(4).padStart(10)}  ${String(b.input).padStart(10)}  ${String(b.cached).padStart(10)}  ${String(b.output).padStart(10)}` +
        (b.unpriced ? `   (${b.unpriced} unpriced)` : "") +
        (b.failed ? `   (${b.failed} failed)` : ""),
    );
  }
  console.log(
    `\n${"TOTAL".padEnd(w)}  ${String(total.calls).padStart(7)}  ${total.cost.toFixed(4).padStart(10)}`,
  );
  if (total.unpriced) {
    console.log(
      `\n${total.unpriced} call(s) have no price — TTS audio output, or a model missing from the\n` +
        `price table in lib/ai/usage-log.ts. Reconcile those against the real invoice.`,
    );
  }
  const perThousand = (total.cost / total.calls) * 1000;
  console.log(`\n$${perThousand.toFixed(2)} per 1000 calls at this mix.\n`);
}

void main();
