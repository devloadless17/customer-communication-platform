/**
 * Custom Next.js server.
 *
 * CLAUDE.md ruled out managed alternatives — Socket.io shares the same HTTP
 * port as Next.js so deployment stays one process behind one reverse proxy.
 *
 * Run with `npm run dev` (which uses `tsx watch server.ts`) or `npm start`
 * (`tsx server.ts`).
 *
 * Turbopack on custom server (Next 15.5+): we opt in via `turbopack: true`.
 * Webpack's lazy-compile path was the culprit behind "first page load is
 * slow, the rest are fast" — every untouched route used to webpack-compile
 * its whole import graph on the first request (1–4s for our inbox + API
 * routes). Turbopack does the same work 5–10x faster.
 */

import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";

import { db } from "./lib/db";
import { validateEnv } from "./lib/env";
import { initSocketServer } from "./lib/socket/server";
import { startAutomationWorker, stopAutomationWorker } from "./lib/automations/worker";
import { closeAutomationQueue } from "./lib/automations/queue";

// Fail-fast on missing required env vars BEFORE Next prepares the build
// graph or Prisma opens a pool. systemd restarts on exit(1), so a missing
// secret produces a clean log + exit instead of a half-booted process.
validateEnv();

/**
 * Broadcasts run in-process via `setImmediate` (see lib/broadcast-runner.ts),
 * so a restart mid-send leaves rows stuck at `running` forever — the progress
 * UI would lie indefinitely. On boot, mark any such orphan as `failed`. The
 * per-recipient rows already carry their own status, so a future "resume"
 * could re-enqueue the `queued` ones; for now, fail-fast so the dashboard is
 * honest.
 */
async function reconcileInterruptedBroadcasts(): Promise<void> {
  try {
    const { count } = await db.broadcast.updateMany({
      where: { status: "running" },
      data: {
        status: "failed",
        completedAt: new Date(),
        lastError: "interrupted by a server restart",
      },
    });
    if (count > 0) {
      console.warn(`[server] marked ${count} interrupted broadcast(s) as failed on boot`);
    }
  } catch (err) {
    console.error("[server] broadcast reconciliation failed", err);
  }
}

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME ?? "localhost";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

const app = next({ dev, hostname, port, turbopack: dev });
const handle = app.getRequestHandler();

void app.prepare().then(async () => {
  const httpServer = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Bad Request");
      return;
    }
    void handle(req, res, parse(req.url, true));
  });

  initSocketServer(httpServer);

  // Block the server from accepting requests until Prisma has at least one
  // warm connection. Awaiting (not fire-and-forget) ensures the first login
  // — including its Auth.js authorize() DB lookup — never hits a cold pool.
  // The count() forces an actual round-trip; $connect() alone doesn't always
  // open a usable connection on every Prisma engine version.
  try {
    await db.$connect();
    await db.user.count();
  } catch (err) {
    console.error("[server] prisma warmup failed:", err);
    process.exit(1);
  }

  void reconcileInterruptedBroadcasts();

  // Boot the automations worker in this same Node process. For MVP this is
  // simpler than running a separate worker container; the queue is shared via
  // Redis, so splitting later is a single new entrypoint that calls
  // startAutomationWorker() in isolation. Failures here don't take down the
  // app — Redis being unreachable degrades automations only.
  try {
    startAutomationWorker();
  } catch (err) {
    console.error("[server] failed to start automation worker:", err);
  }

  // Graceful shutdown — stop accepting jobs, then drain BullMQ + Redis. Without
  // this, `docker stop` would force-kill mid-attempt and the run row would stay
  // in `running` forever (we don't have a stuck-job reaper yet).
  const shutdown = async (signal: string) => {
    console.log(`[server] received ${signal}, shutting down...`);
    try {
      await stopAutomationWorker();
      await closeAutomationQueue();
    } catch (err) {
      console.error("[server] shutdown error", err);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  httpServer
    .once("error", (err) => {
      console.error("[server] failed to start:", err);
      process.exit(1);
    })
    .listen(port, () => {
      console.log(
        `> ready on http://${hostname}:${port} (socket.io path: /api/socket, dev=${dev})`,
      );
    });
});
