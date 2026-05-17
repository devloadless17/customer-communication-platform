import "reflect-metadata";

import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";

import { validateEnv } from "@ccp/config";

import { AppModule } from "./app.module";
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
async function bootstrap(): Promise<void> {
  // Validate environment BEFORE constructing the DI graph — if a required env
  // var is missing, fail loudly here rather than crashing midway through
  // PrismaService.onModuleInit or similar with an obscure stack trace.
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

  // Cookie parsing for the Better Auth session cookie (read by SessionGuard).
  // The cookie itself is set by Next.js on signin; we only need to read it.
  app.use(cookieParser());

  // Raw body capture for webhook ingest. Meta's HMAC-SHA256 signature is
  // computed over the *raw* request body — JSON-parsing first would let a
  // single whitespace mismatch fail verification. We keep the raw bytes on
  // `req.rawBody` and still let downstream controllers consume the parsed
  // JSON via the standard @Body() decorator.
  //
  // The verify callback runs on every parsed JSON request, but only webhook
  // paths actually need the raw bytes — copying the buffer for internal REST
  // calls is pure waste. Scoping the Buffer.from() to /webhooks/* keeps a
  // ~5kb allocation off the hot path of every other API request while
  // preserving HMAC integrity where it matters.
  app.use(
    bodyParser.json({
      limit: "2mb",
      verify: (req, _res, buf) => {
        const url = (req as unknown as { url?: string }).url;
        if (url && url.startsWith("/webhooks/")) {
          (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(buf);
        }
      },
    }),
  );
  app.use(bodyParser.urlencoded({ extended: true, limit: "2mb" }));

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
  const productionOrigin = process.env.APP_PUBLIC_URL;
  app.enableCors({
    origin:
      process.env.NODE_ENV === "production"
        ? productionOrigin
          ? [productionOrigin]
          : false
        : ["http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true,
  });

  const port = Number(process.env.API_PORT ?? 4000);
  const host = process.env.API_HOST ?? "0.0.0.0";
  await app.listen(port, host);

  const logger = new Logger("Bootstrap");
  logger.log(`NestJS API listening on http://${host}:${port}`);
  logger.log(
    `Worker mode: ${process.env.RUN_WORKER_INLINE === "0" ? "external" : "inline"}`,
  );
}

void bootstrap();
