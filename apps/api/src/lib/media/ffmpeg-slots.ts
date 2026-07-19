/**
 * Process-wide concurrency gate for ffmpeg subprocesses.
 *
 * WHY THIS EXISTS
 *
 * Every ffmpeg call site (video poster frames, image thumbnails, duration
 * probes, voice-note transcodes) spawns a child process with no ceiling on
 * how many run at once. Each one is CPU-bound and holds the whole source
 * media in memory. Nothing in the codebase bounded the total, and the paths
 * that reach it are the easiest in the system to burst:
 *
 *   - Meta delivers inbound webhooks at-least-once and in parallel. Twenty
 *     customers sending videos inside the same second is twenty concurrent
 *     ffmpeg processes, all decoding video.
 *   - The inbound-media sweeper retries a backlog of pending media, which is
 *     by definition a batch.
 *
 * The damage isn't the ffmpeg work itself — it's that these processes are
 * children of the api container and count against its 2GB `mem_limit`. Enough
 * concurrent decodes and the container OOM-kills: not the ffmpeg child, the
 * API. Every agent's inbox drops, every socket reconnects, in-flight sends
 * are re-run from their BullMQ locks. A customer sending a video should never
 * be able to reach that outcome, and a burst of them shouldn't either.
 *
 * Node's event loop offers no protection here: `spawn` hands off to the OS
 * scheduler, so N spawns really do run N-wide and the loop stays responsive
 * right up until the kernel OOM-killer picks the container.
 *
 * WHAT THIS DOES
 *
 * A counting semaphore with a FIFO wait queue, plus a bounded wait so work
 * queues instead of piling up. On wait-timeout the caller gets a throw, and
 * every ffmpeg caller in this codebase already degrades gracefully: the
 * thumbnail paths return null (bubble renders without a poster) and the
 * transcode paths fall back to sending the original bytes. Degrading a
 * poster frame under load is the correct trade against killing the API.
 *
 * Defaults: 2 concurrent (FFMPEG_CONCURRENCY). Deliberately conservative —
 * the api shares an 8GB VPS with Postgres, Redis, and the web process, and
 * two parallel decodes is already a meaningful slice of it. Raise it only
 * against a measured queue-wait, not a guess.
 *
 * Single-process, like every other in-memory gate here (CLAUDE.md §16); a
 * second app instance would need a shared counter.
 *
 * NOTE: this module deliberately imports NOTHING. It is pulled in by both
 * media modules and, indirectly, by the webhook controller; a dependency-free
 * leaf can't participate in an import cycle. That is not hypothetical — an
 * earlier metrics helper here caused a TDZ crash at runtime that typecheck
 * passed clean.
 */

/** Default wait budget for best-effort work (thumbnails, duration probes). */
export const FFMPEG_WAIT_BEST_EFFORT_MS = 10_000;

/**
 * Longer budget for outbound voice-note transcodes. These are NOT equivalent
 * to the thumbnail paths: skipping the transcode means sending browser-native
 * mp4, which Meta accepts on upload and then silently fails to DELIVER. The
 * user sees a sent voice note the recipient never gets. Worth waiting longer
 * in a queue for, so it only degrades under sustained load rather than a blip.
 */
export const FFMPEG_WAIT_OUTBOUND_MS = 30_000;

function maxConcurrent(): number {
  const raw = Number.parseInt(process.env.FFMPEG_CONCURRENCY ?? "2", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 16 ? raw : 2;
}

let active = 0;
const waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

/** Depth at which a sustained backlog gets an operator signal. */
const WAIT_DEPTH_WARN = 8;
let warnedAtDepth = false;

function release(): void {
  const next = waiters.shift();
  if (next) {
    // Hand the slot straight to the next waiter — do NOT decrement first, or a
    // caller arriving between the decrement and the handoff can steal it and
    // push `active` over the cap.
    next.resolve();
    return;
  }
  active = Math.max(0, active - 1);
  if (waiters.length === 0) warnedAtDepth = false;
}

function acquire(waitMs: number): Promise<void> {
  if (active < maxConcurrent()) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const entry = {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject,
    };
    const timer = setTimeout(() => {
      const i = waiters.indexOf(entry);
      if (i >= 0) waiters.splice(i, 1);
      reject(
        new Error(
          `ffmpeg slot wait exceeded ${waitMs}ms (${active} active, ${waiters.length} queued)`,
        ),
      );
    }, waitMs);
    timer.unref();
    waiters.push(entry);

    if (waiters.length >= WAIT_DEPTH_WARN && !warnedAtDepth) {
      warnedAtDepth = true;
      console.warn(
        `[ffmpeg] ${waiters.length} media jobs queued behind ${maxConcurrent()} slots — ` +
          `sustained backlog degrades thumbnails and voice-note transcodes`,
      );
    }
  });
}

/**
 * Run `fn` holding one ffmpeg slot. Throws if no slot frees within `waitMs`;
 * callers must already handle a throw as "skip this optimisation".
 */
export async function withFfmpegSlot<T>(
  waitMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  await acquire(waitMs);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Observability for /health — a persistently deep queue means the cap is too low. */
export function ffmpegSlotStats(): { active: number; queued: number } {
  return { active, queued: waiters.length };
}
