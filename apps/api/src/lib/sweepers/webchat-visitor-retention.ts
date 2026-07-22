import { db } from "@/lib/db";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";
import { EPHEMERAL_CONTACT_CHANNELS } from "@ccp/shared/providers/capabilities";

/**
 * Retention sweeper for ANONYMOUS website-widget visitors.
 *
 * A widget visitor's identity is a `vis_<uuid>` in one browser's localStorage —
 * clear it, switch device, or open incognito and the same person is a brand-new
 * Contact + Conversation, permanently. Nothing else in the codebase ever deletes a
 * Contact or Conversation, so these accumulate without bound (the one-per-pageview
 * rows from storage-blocked browsers, every abandoned first "hello", every rotated
 * session). On the single VPS that growth is the concern.
 *
 * What it deletes — deliberately narrow:
 *   - `identityChannel` in EPHEMERAL_CONTACT_CHANNELS (webchatwidget today), AND
 *   - ANONYMOUS: no phone AND no email. A visitor who self-identified was PROMOTED
 *     into the directory and is a real contact — never touched. This is the same
 *     `isDirectoryContact` line the directory queries use, in reverse.
 *   - no message activity within the window (the contact's `lastInboundAt`, and no
 *     conversation touched since the cutoff).
 *
 * Deleting the Contact cascades to its Conversation and Messages (FK onDelete). The
 * orphaned solo `Customer` each anonymous visitor mints is reaped too (guarded to
 * customers with no remaining contacts — the same guard customer-link-drift uses).
 * R2 blobs are left to the existing blob-orphan sweeper rather than deleted inline.
 *
 * Because sessions rotate at 30 days client-side, an abandoned visitor's rows are
 * already unreachable well before this 90-day cutoff — the two policies compose.
 *
 * Cadence: daily, batched, bounded — mirrors conversation-event-retention.
 * Tunable via WEBCHAT_VISITOR_RETENTION_DAYS (default 90). Boot slot 45min —
 * 12/30/35/40 are taken by the other daily sweepers.
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const INITIAL_DELAY_MS = 45 * 60_000;
const DEFAULT_RETENTION_DAYS = 90;
const MAX_PER_SWEEP = 5_000;
const MAX_BATCHES = 4;

const EPHEMERAL = [...EPHEMERAL_CONTACT_CHANNELS];

function retentionMs(): number {
  const raw = Number.parseInt(process.env.WEBCHAT_VISITOR_RETENTION_DAYS ?? "", 10);
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
  return days * 24 * 60 * 60_000;
}

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("webchat-visitor-retention", sweepOnce);
  } catch (err) {
    // Pool already ended (dev hot-reload / shutdown) — the work is
    // over, so stop instead of logging a stack trace every tick.
    if (isPoolClosedError(err)) {
      stopWebchatVisitorRetentionSweeper();
      return;
    }
    console.error(`[sweeper.webchat-visitor-retention] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startWebchatVisitorRetentionSweeper(): void {
  if (timer || initialTimer) return;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runTick("initial sweep");
    timer = setInterval(() => {
      void runTick("sweep");
    }, SWEEP_INTERVAL_MS);
    timer.unref?.();
  }, INITIAL_DELAY_MS);
  initialTimer.unref?.();
}

export function stopWebchatVisitorRetentionSweeper(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweepOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - retentionMs());
  let totalDeleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    // Anonymous ephemeral contacts idle since the cutoff. `lastInboundAt` is the
    // cheap activity proxy (a null one — a visitor who never sent — is also stale
    // if the row itself predates the cutoff).
    const stale = await db.contact.findMany({
      where: {
        identityChannel: { in: EPHEMERAL },
        deletedAt: null,
        phoneNumber: null,
        email: null,
        OR: [{ lastInboundAt: { lt: cutoff } }, { lastInboundAt: null, createdAt: { lt: cutoff } }],
      },
      select: { id: true, customerId: true },
      take: MAX_PER_SWEEP,
    });
    if (stale.length === 0) break;

    const contactIds = stale.map((r) => r.id);
    const customerIds = [...new Set(stale.map((r) => r.customerId).filter((x): x is string => !!x))];

    // Contact delete cascades to Conversation + Message (schema FKs).
    const { count } = await db.contact.deleteMany({ where: { id: { in: contactIds } } });
    totalDeleted += count;

    // Reap the now-childless solo Customer each anonymous visitor minted. Guarded
    // to customers with zero remaining contacts, so a shared/linked Customer is
    // never removed — same guard as customer-link-drift.
    if (customerIds.length > 0) {
      await db.customer.deleteMany({
        where: { id: { in: customerIds }, contacts: { none: {} } },
      });
    }
    if (stale.length < MAX_PER_SWEEP) break;
  }
  if (totalDeleted > 0) {
    console.log(
      `[sweeper.webchat-visitor-retention] removed ${totalDeleted} anonymous widget visitor(s) idle > ${retentionMs() / 86_400_000}d`,
    );
  }
}
