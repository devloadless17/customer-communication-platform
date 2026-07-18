import "reflect-metadata";

import bodyParser from "body-parser";
import compression from "compression";
import cookieParser from "cookie-parser";
import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import type { Request, Response, NextFunction } from "express";

import { validateEnv } from "@ccp/config";

import { AppModule } from "./app.module";
import { consumeUnauthIpToken } from "./auth/api-key.guard";
import { correlationMiddleware } from "./common/correlation";
import { ipRateLimitMiddleware } from "./common/ip-rate-limit.middleware";
import { drainSockets, WsAdapter } from "./realtime/ws-adapter";

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
// Set by bootstrap() once the app + graceful shutdown are wired, so the fatal
// handler below can drain in-flight work before exiting.
let triggerGracefulShutdown: ((signal: string) => Promise<void>) | null = null;
let fatalExiting = false;

/**
 * Handle a truly-uncaught synchronous exception. The process state is now
 * UNDEFINED — it must NOT keep serving (it could corrupt data or, worse, leave
 * a half-run worker job that another pickup re-executes → double Meta send).
 *
 * The one documented benign case (BullMQ blocking-connection ECONNRESET on the
 * duplicated Redis socket) is handled UPSTREAM at each Worker's `.on("error")`,
 * so reaching here is genuinely unexpected. We drain in-flight work first —
 * abrupt `exit()` would strand a mid-flight BullMQ job whose lock expires in 90s
 * and gets re-executed (the exact double-fire the graceful path prevents) — then
 * exit so Docker's `restart: unless-stopped` brings up a clean process. A
 * watchdog forces exit if the drain itself hangs (likely, given a corrupt
 * state); its 30s budget stays under compose's `stop_grace_period`.
 */
function fatalExit(reason: string): void {
  if (fatalExiting) return;
  fatalExiting = true;
  const backstop = setTimeout(() => {
    console.error(`[${reason}] graceful drain timed out — forcing exit`);
    process.exit(1);
  }, 30_000);
  backstop.unref();
  if (triggerGracefulShutdown) {
    void triggerGracefulShutdown(reason);
  } else {
    // Crashed before the app was ready — no in-flight work to drain.
    process.exit(1);
  }
}

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  fatalExit("uncaughtException");
});
// unhandledRejection stays log-and-continue: it's dominated by fire-and-forget
// `void publish(...)` sites whose failure must not take down the api. A missing
// `.catch` is a bug to fix at the call site, not a reason to crash the process.
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

  // Trust N reverse-proxy hops in front of us. Single-Caddy topology = 1;
  // a Cloudflare/CDN → Caddy → api chain = 2; etc. Wrong value silently
  // breaks per-IP rate-limiting: too low and req.ip is the proxy loopback
  // (every request collapses onto one bucket); too high and a hostile
  // client can spoof X-Forwarded-For (every request looks like a fresh
  // IP). validateEnv enforces the value is an integer 0..10 in prod, so
  // this read is safe by the time we reach it. Default 1 (today's topology)
  // when the env is unset in dev. Was hard-coded to 1; making this dynamic
  // closes the gap the schema was validating but main.ts ignored.
  const trustProxyHops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "1", 10);
  app.set("trust proxy", trustProxyHops);

  // Correlation ID binding MUST run before any other middleware so logs
  // emitted during body parsing, auth, etc. all see the same id. Express
  // middleware runs in registration order; this needs to be first.
  app.use(correlationMiddleware());

  // Cookie parsing for the Better Auth session cookie (read by SessionGuard).
  // The cookie itself is set by Next.js on signin; we only need to read it.
  app.use(cookieParser());

  // gzip/deflate compression for JSON responses. Critical on slow
  // networks: a typical conversations-list payload is ~80-150KB
  // uncompressed and compresses to ~12-20KB. Without this, the request
  // takes 8-10× longer on 3G.
  //
  // In production Caddy already compresses at the edge (`encode zstd
  // gzip` in deploy/Caddyfile.template), so this is defense-in-depth.
  // It IS the only source of compression in `npm run api:dev` (Caddy
  // isn't in the loop locally), which is where 3G testing usually
  // happens — without this middleware every JSON fetch is naked.
  //
  // `threshold: 1024` skips payloads tiny enough that the gzip overhead
  // exceeds the savings (login responses, health checks). Webhook routes
  // are also skipped — Meta doesn't send Accept-Encoding so this is a
  // no-op there, but the explicit filter saves a header lookup per call.
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) => {
        // Skip webhook responses (typically `{ok: true}`-shaped, tiny).
        const url = req.url ?? "";
        if (url.startsWith("/webhooks/")) return false;
        return compression.filter(req, res);
      },
    }),
  );

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
      // Consume from the api-key guard's per-IP unauth bucket. The
      // ipRateLimitMiddleware deliberately skips /v1 (partners with valid
      // keys are metered per-key), but unauthenticated probing must still
      // be throttled. Without this, a scripted attacker stamping
      // `Origin: anything` on every /v1 hit would get unlimited cheap
      // 403s — bypassing the brake on anonymous probing entirely. Upgrade
      // to 429 when the IP has spent its budget so the attacker can't
      // distinguish "shape-rejected" from "throttled" by latency alone.
      const r = consumeUnauthIpToken(req.ip ?? "unknown");
      if (!r.ok) {
        res.setHeader("Retry-After", String(r.retryAfter));
        res.status(429).json({
          error: "rate_limited",
          detail: "30 unauthenticated req/min/IP on /v1",
          retryAfter: r.retryAfter,
        });
        return;
      }
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

  // The embeddable chat widget runs on arbitrary CUSTOMER origins, so its public
  // endpoints (POST /api/widget/media, GET /api/widget/media/:id) must accept
  // cross-origin requests. Reflect the request Origin but WITHOUT credentials —
  // the widget authenticates with a public site key in the query, never cookies,
  // so reflecting the origin here can't enable a credentialed CSRF (the footgun
  // the pinned enableCors below avoids). The REAL boundary is the per-widget
  // origin allow-list enforced in the controller/gateway, not this header. Runs
  // BEFORE enableCors and fully answers the preflight so the pinned policy (which
  // wouldn't allow a third-party origin) never rejects it.
  app.use("/api/widget", (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers["origin"];
    if (typeof origin === "string" && origin.length > 0) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Max-Age", "7200");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
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

  // Same posture for the SSRF escape hatch. INTEGRATIONS_ALLOW_PRIVATE_HOSTS
  // is a dev-only convenience that lets safe-fetch reach private/loopback
  // addresses; in production it lets a tenant-configured webhook / workflow
  // http_request hit internal services or the cloud metadata endpoint. The
  // compose default is "0", but a misconfigured prod env must fail loudly,
  // not silently disarm the SSRF guard.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.INTEGRATIONS_ALLOW_PRIVATE_HOSTS === "1"
  ) {
    console.error(
      "FATAL: INTEGRATIONS_ALLOW_PRIVATE_HOSTS=1 in production. This disables " +
        "the safe-fetch SSRF guard, letting tenant webhooks/http-requests reach " +
        "internal hosts + cloud metadata. Refusing to boot.",
    );
    process.exit(1);
  }

  // Same fail-loud posture for RUN_WORKER_INLINE=0 in production. Setting it
  // disables the in-process workflow worker, ALL sweepers, the broadcast-
  // schedule worker, the send worker, and the outbound-webhook worker
  // (WorkflowWorkerService.onModuleInit + the sibling worker services all gate
  // on it). It's meant to hand off to a standalone worker container — but no
  // such entrypoint exists today (only main.ts; the `worker` compose service +
  // worker entrypoint were removed post-Phase-5). So `0` is NOT "external
  // worker takes over" — it's a TOTAL silent outage: message sends still 2xx,
  // health checks stay green, but nothing drains. A single mistyped
  // API_RUN_WORKER_INLINE on a deploy would dark-fail the whole automation +
  // send + broadcast + webhook surface. Refuse to boot loudly until a real
  // external worker entrypoint ships (at which point relax this guard).
  if (
    process.env.NODE_ENV === "production" &&
    process.env.RUN_WORKER_INLINE === "0"
  ) {
    console.error(
      "FATAL: RUN_WORKER_INLINE=0 in production, but no external worker " +
        "entrypoint exists — the workflow worker, all sweepers, the broadcast " +
        "scheduler, and the send/webhook workers would all be silently disabled " +
        "(sends still 2xx, health stays green, nothing drains). Refusing to boot. " +
        "Leave RUN_WORKER_INLINE unset or =1 until a standalone worker container ships.",
    );
    process.exit(1);
  }

  // Same fail-loud posture for the dev-only webhook signature bypass. Setting it
  // makes the inbound Meta webhook routes accept ANY body without HMAC
  // verification (a local-tunnel convenience) — catastrophic in production,
  // where anyone could forge inbound messages/status. The runtime check also
  // hard-gates on NODE_ENV, but a prod env carrying this flag is a red flag on
  // its own, so refuse to boot.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.META_WEBHOOK_INSECURE_SKIP_VERIFY === "1"
  ) {
    console.error(
      "FATAL: META_WEBHOOK_INSECURE_SKIP_VERIFY=1 in production. This disables " +
        "inbound webhook HMAC verification, letting anyone forge Meta events. " +
        "Refusing to boot. It's a local-dev-only flag.",
    );
    process.exit(1);
  }

  // NOTE: CORS preflight (OPTIONS) responses are emitted by enableCors BEFORE
  // any guard runs — the SessionGuard / RateLimitInterceptor / ApiKeyGuard chain is
  // skipped for OPTIONS by design. Today this is harmless because Caddy makes
  // web+api same-origin in prod (no preflight ever sent) and dev only allows
  // localhost:3000. If/when api moves to a separate domain in prod (or a
  // second trusted Origin is added), revisit: a multi-domain deploy needs
  // either an explicit OPTIONS handler that runs the rate-limit interceptor, or
  // an origin allow-list narrow enough that preflight bypass is moot.
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

  const port = Number(process.env.API_PORT ?? 4000);
  const host = process.env.API_HOST ?? "0.0.0.0";
  const server = await app.listen(port, host);

  // Hard timeouts on the HTTP server. Node defaults are either disabled
  // (`requestTimeout=0` on older versions) or far too generous, so a
  // slowloris client or a partner that opens a POST and never closes it can
  // pin parser threads and FDs indefinitely. Numbers picked so:
  //   - headersTimeout (10s) is shorter than Caddy's idle (60s) so a stuck
  //     header phase is reaped before Caddy gives up. This is the ACTUAL
  //     slow-loris vector — an attacker dribbling headers byte-by-byte — and
  //     it stays tight regardless of the body budget below.
  //   - requestTimeout (300s) counts against receiving the ENTIRE request
  //     INCLUDING the body (Node ≥18). The 30s it used to be silently killed
  //     the media-send path the product explicitly supports: multipart uploads
  //     up to 100 MiB (image 4.8MB, video/audio 15MB, document 95MB per the
  //     reply-box client caps), which on a normal uplink can legitimately take
  //     minutes — Caddy streams the body straight through, so this server's
  //     timer is what fires. 300s (Node's own default) covers the worst
  //     legitimate upload; slow-loris protection lives in headersTimeout, not
  //     here. NOTE: the client's media AbortController (reply-box.tsx, 90s) is
  //     intentionally TIGHTER — it gives up on a stalled upload before the
  //     server does; this ceiling just stops the server pre-empting a slow but
  //     live transfer.
  //   - keepAliveTimeout (65s) is just over the typical proxy idle so we
  //     don't reset connections Caddy still thinks are alive.
  server.requestTimeout = 300_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 65_000;

  // Graceful shutdown — drive the lifecycle ourselves instead of using
  // app.enableShutdownHooks(). NestJS's bundled SIGTERM handler fires
  // OnModuleDestroy hooks (where BullMQ workers drain — up to 90s) BEFORE
  // the HTTP server is closed, so during that 90s window the api still
  // accepts new requests that get SIGKILL'd when compose's stop_grace_period
  // (100s on the api service) expires. Inverting that order lets Caddy mark
  // the upstream unhealthy immediately while workers finish in-flight jobs in
  // the background.
  //
  // Sequence:
  //   0. drainSockets()             — disconnect Socket.io clients with a
  //                                    proper close frame so they reconnect
  //                                    immediately, and so the open
  //                                    WebSockets stop pinning the HTTP
  //                                    server open in step 1
  //   1. server.close()             — stop accepting new TCP connections
  //                                    (returns immediately; existing
  //                                    connections continue)
  //   2. closeIdleConnections()     — force idle keep-alives shut so
  //                                    Caddy's next probe sees us as down
  //                                    within ~250ms instead of waiting for
  //                                    them to time out
  //   3. wait ~3s                   — gives in-flight HTTP responses a
  //                                    chance to flush; covers ~99% of
  //                                    normal request durations
  //   4. app.close()                — fires OnModuleDestroy (workers drain
  //                                    up to lockDuration=90s),
  //                                    beforeApplicationShutdown, then
  //                                    closes the HTTP server completely,
  //                                    then onApplicationShutdown. CAPPED at
  //                                    APP_CLOSE_BUDGET_MS — the per-worker
  //                                    close caps run SEQUENTIALLY and sum
  //                                    past stop_grace_period otherwise.
  //   5. process.exit(0)            — clean exit before compose's
  //                                    stop_grace_period (100s) hard-kills us
  //
  // `process.on` (not `once`) so a repeated SIGTERM (e.g., from impatient
  // ops) is OBSERVED — the shuttingDown flag still prevents re-entry, but
  // the second signal gets a log line instead of silent swallow. Without
  // this, an operator who SIGTERMs twice has no way to tell whether the
  // first signal landed.
  const shutdownLogger = new Logger("Shutdown");
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      shutdownLogger.warn(`${signal} received again — shutdown already in progress`);
      return;
    }
    shuttingDown = true;
    shutdownLogger.log(`${signal} received — starting graceful drain`);

    // Drain Socket.io BEFORE server.close(). Open WebSockets otherwise keep
    // the HTTP server from ever closing, so the close below always fell
    // through its 3s fallback and every agent's socket died with the process
    // (abrupt reset → full client reconnect backoff → seconds of dead inbox
    // on every deploy). A deliberate disconnect tells clients to reconnect
    // immediately and lets server.close() resolve on its own.
    try {
      const drained = await drainSockets();
      if (drained > 0) {
        shutdownLogger.log(`disconnected ${drained} socket(s) for reconnect`);
      }
    } catch (err) {
      shutdownLogger.warn(
        `socket drain failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Don't await the callback path forever — if a long-poll or
        // websocket holds the server open, fall through after a short
        // budget and let app.close() finish the job.
        setTimeout(resolve, 3_000).unref();
      });
      if (typeof server.closeIdleConnections === "function") {
        server.closeIdleConnections();
      }
    } catch (err) {
      shutdownLogger.error("server.close() failed", err as Error);
    }

    // Bound the TOTAL app.close() drain. OnModuleDestroy hooks run
    // SEQUENTIALLY in reverse-init order, and each worker's close cap is
    // individually under the grace window (workflow ~90s lockDuration, send
    // 85s, webhook 45s, sweepers fast) — but ADDITIVELY they exceed compose's
    // stop_grace_period (100s on api). If all are simultaneously stuck at
    // their caps, an unbounded app.close() overruns 100s and Docker SIGKILLs
    // us mid-drain, which re-executes the in-flight job after restart. We've
    // already spent up to 3s above, so cap app.close() here and, on overrun,
    // fall through to a controlled process.exit(0): any worker that didn't
    // finish draining has its BullMQ lock expire and is re-claimed cleanly on
    // restart — same outcome as the SIGKILL, but we exit 0 instead of being
    // killed mid-fsync. OutboundSendAttempt(jobId) still guards that rare
    // re-execution against a double Meta send.
    const APP_CLOSE_BUDGET_MS = 90_000;
    try {
      await Promise.race([
        app.close(),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            shutdownLogger.warn(
              `app.close() exceeded ${APP_CLOSE_BUDGET_MS}ms — exiting before ` +
                `stop_grace_period SIGKILL; any undrained in-flight job is re-` +
                `claimed via BullMQ lock expiry on restart`,
            );
            resolve();
          }, APP_CLOSE_BUDGET_MS).unref(),
        ),
      ]);
    } catch (err) {
      shutdownLogger.error("app.close() failed", err as Error);
    }

    shutdownLogger.log("graceful drain complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // Let the top-level fatal handler (uncaughtException) drain via this same
  // path instead of exiting abruptly mid-job.
  triggerGracefulShutdown = shutdown;

  const logger = new Logger("Bootstrap");
  logger.log(`NestJS API listening on http://${host}:${port}`);
  logger.log(
    `Worker mode: ${process.env.RUN_WORKER_INLINE === "0" ? "external" : "inline"}`,
  );
}

bootstrap().catch((err) => {
  // A boot failure (env validation, DbService.$connect, app.listen) must exit
  // non-zero so `restart: unless-stopped` retries — NOT fall through to the
  // log-and-continue unhandledRejection handler, which would idle a zombie
  // process (IORedis/BullMQ reconnect timers keep the loop alive) with nothing
  // bound to the port.
  console.error("[bootstrap] fatal:", err);
  process.exit(1);
});
