/**
 * Custom Next.js server.
 *
 * CLAUDE.md ruled out managed alternatives — Socket.io shares the same HTTP
 * port as Next.js so deployment stays one process behind one reverse proxy.
 *
 * Run with `npm run dev` (which uses `tsx watch server.ts`) or `npm start`
 * (`tsx server.ts`).
 *
 * Tradeoff: this disables Turbopack dev. HMR is slower than `next dev`.
 */

import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";

import { db } from "./lib/db";
import { initSocketServer } from "./lib/socket-server";

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

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

void app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Bad Request");
      return;
    }
    void handle(req, res, parse(req.url, true));
  });

  initSocketServer(httpServer);

  void reconcileInterruptedBroadcasts();

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
