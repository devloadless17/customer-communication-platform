import { db } from "@/lib/db";
import { enumerateOnlineUsers } from "@/lib/conversations/presence-bridge";
import { isPoolClosedError } from "@/lib/sweepers/_mutex";

/**
 * Agent online-time sampler — the writer behind `AgentPresenceDaily`, which
 * the team report sums into its per-agent "Online" column.
 *
 * Every SAMPLE_INTERVAL_MS it reads the in-memory socket presence registry
 * (via the presence bridge's enumerator) and increments `onlineMinutes` by
 * the interval for every (workspace, user) currently connected, keyed on the
 * UTC day.
 *
 * SAMPLING, not session rows, on purpose: a session ledger needs an "ended"
 * write that a crash or SIGKILL never gets to make, and a dangling open
 * session silently inflates someone's hours until a healer notices. With
 * sampling the failure mode inverts and shrinks: the worst a crash costs is
 * ONE unsampled interval (5 minutes), and the ledger can never overcount.
 * The ±5min quantization error is irrelevant at "hours online per day"
 * granularity.
 *
 * No sweeper mutex: unlike the retention sweeps this does no batched deletes,
 * writes a bounded row set (connected agents, tens at this scale), and runs
 * only where the enumerator is wired (the api process that owns the sockets —
 * a standalone worker gets `null` and skips).
 *
 * AGENT_PRESENCE_SAMPLE=0 disables (local dev with long-lived idle tabs).
 */

const SAMPLE_INTERVAL_MS = 5 * 60_000;
const SAMPLE_MINUTES = SAMPLE_INTERVAL_MS / 60_000;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

/** The UTC day bucket for "now" — matches the `@db.Date` column. */
function utcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Exported for tests, matching the sibling sweepers' convention. */
export async function sampleAgentPresenceOnce(): Promise<void> {
  const online = enumerateOnlineUsers();
  // null = no presence registry in this process; [] = nobody connected.
  // Either way there is nothing to add.
  if (!online || online.length === 0) return;

  const date = utcToday();
  for (const { workspaceId, userId } of online) {
    await db.agentPresenceDaily.upsert({
      where: { workspaceId_userId_date: { workspaceId, userId, date } },
      create: { workspaceId, userId, date, onlineMinutes: SAMPLE_MINUTES },
      update: { onlineMinutes: { increment: SAMPLE_MINUTES } },
    });
  }
}

async function runTick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await sampleAgentPresenceOnce();
  } catch (err) {
    if (isPoolClosedError(err)) {
      stopAgentPresenceSampler();
      return;
    }
    console.error("[sweeper.agent-presence-sample] tick failed", err);
  } finally {
    inFlight = false;
  }
}

export function startAgentPresenceSampler(): void {
  if (timer) return;
  if (process.env.AGENT_PRESENCE_SAMPLE === "0") return;
  timer = setInterval(() => {
    void runTick();
  }, SAMPLE_INTERVAL_MS);
  timer.unref?.();
}

export function stopAgentPresenceSampler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
