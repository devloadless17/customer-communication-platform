import "reflect-metadata";

import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import type { Request, Response, NextFunction } from "express";

import { validateEnv } from "@ccp/config";

import { AppModule } from "./app.module";
import { correlationMiddleware } from "./common/correlation";
import { ipRateLimitMiddleware } from "./common/ip-rate-limit.middleware";
import { WsAdapter } from "./realtime/ws-adapter";

/**
 * NestJS entrypoint. Sits next to Next.js on the same VPS, on a different
 * port. Caddy routes `/api/*`, `/socket.io/*`, and `/webhooks/*` here while
 * `/api/auth/*` and the frontend stay on Next.js.
 *
 * Phase 1 surface area is intentionally tiny: a health endpoint and an
 * empty Socket.io gateway. Existing Next.js routes are unaffected; this
 * process just sits idle until Phase 2 starts moving traffic to it.
 */
// Process-level safety net for errors that escape the framework's own
// boundaries. The most common offender at pilot scale is BullMQ's internal
// blocking-connection (the IORedis instance the Worker `.duplicate()`s for
// BRPOPLPUSH). That duplicate doesn't share the .on("error") listener we
// attach to the queue's primary connection, so a Redis ECONNRESET emits an
// 'error' event with no handler → Node crashes with an uncaughtException.
// systemd Restart=always would bring us back in ~3s, but that's still a
// hard 502 window where a soft reconnect would have been transparent.
//
// IORedis itself reconnects automatically. We just need to keep the process
// alive long enough for that to happen. Log the error so it's visible in
// systemd-journald, then return — same posture pm2/cluster would give us
// without the runtime dep.
//
// `unhandledRejection` shares the same surface: a `void publish(...).catch(...)`
// site missing a `.catch` would otherwise terminate the process at Node 24's
// default `--unhandled-rejections=throw`. We log instead so a single bus
// publish that throws doesn't take down the whole api.
//
// Note: these are intentionally INSTALLED-ONCE at module load (top-level),
// not inside `bootstrap()`. NestFactory's failure path also routes through
// these — without them a single bad `onModuleInit` would crash before the
// logger is ready and you'd see only the unhelpful default Node stack.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

async function bootstrap(): Promise<void> {
  // Validate environment BEFORE constructing the DI graph — if a required env
  // var is missing, fail loudly here rather than crashing midway through
  // DbService.onModuleInit or similar with an obscure stack trace.
  validateEnv("api");

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Match the existing Next.js logging tone — warn + error in prod, info+ in dev.
    logger:
      process.env.NODE_ENV === "production"
        ? ["log", "warn", "error", "fatal"]
        : ["log", "warn", "error", "fatal", "debug", "verbose"],
    // We sit behind Caddy on the host. Express needs to trust the proxy
    // so req.ip / req.protocol reflect the real client, not 127.0.0.1.
    bodyParser: false,
  });

  // Trust the single Caddy proxy in front of us — same posture as Next.js
  // middleware uses TRUSTED_PROXY_HOPS=1.
  app.set("trust proxy", 1);

  // Correlation ID binding MUST run before any other middleware so logs
  // emitted during body parsing, auth, etc. all see the same id. Express
  // middleware runs in registration order; this needs to be first.
  app.use(correlationMiddleware());

  // Cookie parsing for the Better Auth session cookie (read by SessionGuard).
  // The cookie itself is set by Next.js on signin; we only need to read it.
  app.use(cookieParser());

  // Per-IP rate-limit BEFORE auth. The session guard's bucket only fires
  // once `req.session` is set, so without this an attacker can spam
  // session-guarded routes with garbage cookies and pay the full Better
  // Auth `getSession` cost (a Postgres lookup) per request — easy DoS.
  // Skips /webhooks/*, /api/external/v1, /api/health, /api/socket — those
  // have their own per-key/per-team limits or must remain unmetered.
  app.use(ipRateLimitMiddleware());

  // Raw body capture for HMAC-verified ingest paths. The signature is
  // computed over the *raw* bytes — JSON-parsing first would let a single
  // whitespace mismatch fail verification. We keep the raw bytes on
  // `req.rawBody` and still let downstream controllers consume the parsed
  // JSON via the standard @Body() decorator.
  //
  // The verify callback runs on every parsed JSON request, but only the
  // signature-verified endpoints need the raw bytes — copying the buffer for
  // every internal REST call is pure waste. Two prefixes need it:
  //   - `/webhooks/*`                                     (Meta provider ingest)
  //   - `/api/team/workflows/:id/incoming-webhook`        (per-workflow inbound)
  // Anything else skips the Buffer.from() and stays on the cheap path.
  // 10 MB cap on JSON payloads. Meta webhook bodies are small (KB-scale,
  // they reference media URLs rather than embed binary), and our largest
  // internal POST is a workflow incoming-webhook from a partner. 10 MB
  // gives partners headroom for batched event payloads while still capping
  // a runaway client. Binary media goes through the separate
  // multer-backed upload path, not this JSON parser.
  app.use(
    bodyParser.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        const url = (req as unknown as { url?: string }).url;
        if (!url) return;
        const needsRaw =
          url.startsWith("/webhooks/") ||
          (url.startsWith("/api/team/workflows/") &&
            url.includes("/incoming-webhook"));
        if (needsRaw) {
          (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(buf);
        }
      },
    }),
  );
  app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

  // Socket.io with the same tuning the pre-migration custom server used
  // (path, connection-state-recovery, maxHttpBufferSize, perMessageDeflate
  // off, tighter ping). See realtime/ws-adapter.ts for rationale on each
  // option. When a second app instance is needed, swap WsAdapter for a
  // Redis-adapter-backed subclass — single-line change here, zero changes
  // elsewhere.
  app.useWebSocketAdapter(new WsAdapter(app));

  // Global validation pipe — only runs for non-Zod DTOs (rare). Zod handles
  // most validation via the dedicated ZodValidationPipe per route.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: false,
    }),
  );

  // PrismaExceptionFilter is registered via APP_FILTER in CommonModule
  // (P2025 → 404, P2002/P2003/P2014 → 409, P2024 → 503; rest stay 500) so
  // it's visible to DI and to test bootstraps that build via Test.createTestingModule.

  // CORS: in dev the browser hits Next.js on :3000 and NestJS on :4000 from
  // different origins; in prod Caddy makes them same-origin and CORS is a
  // no-op (the browser never sends an Origin that differs from the page).
  // The credentials flag is required for the session cookie to ride along
  // on cross-origin XHRs in dev.
  //
  // Production pins the allow-list to APP_PUBLIC_URL instead of `true`
  // (which would echo back whatever Origin the client claimed). Same-origin
  // requests don't hit CORS at all, so this is strictly tighter — and the
  // day someone deploys api on a separate subdomain, the misconfig fails
  // loudly instead of silently accepting anyone-with-credentials.
  // Reject any browser-origin request to /api/external/v1/* — this is a
  // server-to-server surface; partners using a leaked key from a browser
  // app (or an XSS payload on a same-origin embed) shouldn't be able to
  // reach it. Server-to-server callers don't set an Origin header, so
  // the check is a safe filter. Runs BEFORE enableCors so the response
  // never sees Access-Control-Allow-Origin echoed back.
  app.use("/api/external/v1", (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers["origin"];
    if (typeof origin === "string" && origin.length > 0) {
      res.status(403).json({
        error: "browser_origin_forbidden",
        detail:
          "The external /v1 API is server-to-server only. Browser requests " +
          "(with an Origin header) are refused.",
      });
      return;
    }
    next();
  });

  // Hard refuse prod boot if the dev-emit toggle is somehow set —
  // /api/dev/emit lets any authenticated user spoof inbound Meta webhook
  // events, so it must NEVER be on in production. Per-request gate
  // exists in the controller too, but a boot-time crash is the only way
  // to catch a misconfigured env var loudly instead of silently.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ENABLE_DEV_TOOLS === "1"
  ) {
    console.error(
      "FATAL: ENABLE_DEV_TOOLS=1 in production. /api/dev/emit would let any " +
        "authenticated user inject inbound webhook events. Refusing to boot.",
    );
    process.exit(1);
  }

  const productionOrigin = process.env.APP_PUBLIC_URL;
  app.enableCors({
    origin:
      process.env.NODE_ENV === "production"
        ? productionOrigin
          ? [productionOrigin]
          : false
        : ["http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true,
    // Cache preflight responses for 2 hours. Without this header browsers
    // re-preflight every non-simple cross-origin request (Chrome defaults to
    // ~5s, Firefox 24h) and a busy inbox session re-pays the OPTIONS round-
    // trip every few requests in dev. 7200s is the practical ceiling: both
    // Chrome and Safari cap the cache at 2h regardless of how high we send.
    // In prod Caddy makes web+api same-origin so CORS is a no-op anyway.
    maxAge: 7200,
  });

  // Register SIGTERM/SIGINT listeners so OnModuleDestroy fires on shutdown.
  // Without this, WorkflowWorkerService.onModuleDestroy never runs and a
  // VPS restart can leave BullMQ jobs in-flight at the 90s lock duration —
  // when Redis releases the lock, the new process picks them up and may
  // execute the same step twice (irreversible Meta sends, tag changes, etc).
  // worker.close() awaits in-flight jobs cleanly before the queue closes.
  app.enableShutdownHooks();

  const port = Number(process.env.API_PORT ?? 4000);
  const host = process.env.API_HOST ?? "0.0.0.0";
  const server = await app.listen(port, host);

  // Hard timeouts on the HTTP server. Node defaults are either disabled
  // (`requestTimeout=0` on older versions) or far too generous, so a
  // slowloris client or a partner that opens a POST and never closes it can
  // pin parser threads and FDs indefinitely. Numbers picked so:
  //   - headersTimeout (10s) is shorter than Caddy's idle (60s) so a stuck
  //     header phase is reaped before Caddy gives up.
  //   - requestTimeout (30s) covers the slowest legitimate upload preflight
  //     while still bounding a stuck body.
  //   - keepAliveTimeout (65s) is just over the typical proxy idle so we
  //     don't reset connections Caddy still thinks are alive.
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 65_000;

  const logger = new Logger("Bootstrap");
  logger.log(`NestJS API listening on http://${host}:${port}`);
  logger.log(
    `Worker mode: ${process.env.RUN_WORKER_INLINE === "0" ? "external" : "inline"}`,
  );
}

void bootstrap();
