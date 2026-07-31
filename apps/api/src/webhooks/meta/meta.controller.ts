import { createHmac, timingSafeEqual } from "node:crypto";

import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";

import type { Channel } from "@ccp/shared/types";

import { createTokenBucket } from "@/common/token-bucket";
import {
  appLevelWebhookEnabled,
  platformAppSecrets,
  platformVerifyToken,
  groupEntriesByWorkspace,
} from "@/lib/providers/app-level-webhook";
import { metaWireEnabled, wireIn } from "@/lib/providers/meta-wire";
import {
  getMetaWebhookConfig,
  getTeamVerifyTokens,
} from "@/lib/providers/config";

/**
 * Which channel a Meta webhook envelope belongs to, from its `object` field.
 * Meta delivers all products to the same callback, so one endpoint fans out by
 * `object`. Reading this from the (untrusted) body to select which channel's
 * app-secret verifies the HMAC is safe: an attacker can flip `object` but still
 * can't forge a valid signature without the secret. `instagram` is added when
 * its provider ships.
 */
function channelForMetaObject(
  payload: unknown,
): "whatsapp" | "messenger" | "instagram" | null {
  if (typeof payload !== "object" || payload === null) return null;
  switch ((payload as { object?: unknown }).object) {
    case "whatsapp_business_account":
      return "whatsapp";
    case "page":
      return "messenger";
    case "instagram":
      return "instagram";
    default:
      return null;
  }
}


import { MetaWebhookIngestService, SOCIAL } from "./meta-webhook-ingest.service";
import { WebhookRateLimitGuard } from "../webhook-rate-limit.guard";

/**
 * The raw request bytes, for HMAC verification.
 *
 * Express's `Request` has no `rawBody` — `main.ts` attaches it from the
 * body-parser `verify` hook, because the signature must be checked against the
 * EXACT bytes Meta signed, not a re-serialisation of the parsed body.
 *
 * One accessor instead of the same cast at four call sites. That is the
 * double-assertion ratchet's actual point: the 4th copy arrived with the
 * app-level webhook route and tripped CI, and the honest fix is to name the
 * contract once rather than raise the baseline. `unknown` in, so this is a single
 * assertion — there is no lying about a type we genuinely add at runtime.
 */
interface RequestWithRawBody {
  rawBody?: Buffer;
}

function rawBodyOf(req: unknown): Buffer | undefined {
  return (req as RequestWithRawBody).rawBody;
}


/**
 * Per-team Meta WhatsApp Cloud API webhook.
 *
 *   GET  /webhooks/meta/:workspaceId   → one-time subscription verify challenge
 *   POST /webhooks/meta/:workspaceId   → real events; HMAC over the raw body
 *
 * Fail-soft posture: malformed payloads still return 200 so Meta doesn't
 * retry-storm.
 *
 * Multi-tenancy: `workspaceId` in the path is a routing signal, NOT proof of
 * origin. The HMAC against the team's per-tenant `metaAppSecret` is the
 * actual authentication.
 */
/**
 * Per-WORKSPACE bucket for the app-level callback.
 *
 * The route guard keys on the `workspaceId` PATH PARAM and falls back to the client
 * IP. On this route there is no path param and every tenant shares Meta's IP set,
 * so that fallback would put all traffic in ONE bucket — a cross-tenant self-DoS.
 * The workspace is only knowable after signature verification + payload resolution,
 * so the fair bucket is consumed inside the handler instead.
 */
const appLevelWorkspaceBucket = createTokenBucket({ perMin: 600, maxKeys: 5_000 });

@Controller("webhooks/meta")
@UseGuards(WebhookRateLimitGuard)
export class MetaWebhookController {
  private readonly logger = new Logger(MetaWebhookController.name);

  constructor(private readonly ingest: MetaWebhookIngestService) {}

  /**
   * APP-LEVEL verification handshake (`GET /webhooks/meta`, no workspaceId).
   *
   * Declared BEFORE the `:workspaceId` routes on purpose: Nest matches in
   * declaration order, and a `:workspaceId` param route would otherwise swallow the
   * bare path.
   */
  @Get()
  async verifyAppLevel(
    @Query("hub.mode") mode: string | undefined,
    @Query("hub.verify_token") token: string | undefined,
    @Query("hub.challenge") challenge: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const expected = platformVerifyToken();
    if (!expected || !appLevelWebhookEnabled()) {
      // Not a Tech Provider yet — the platform app isn't configured. Silent 403
      // rather than "not configured", which would confirm the endpoint exists.
      res.status(403).type("text/plain").send("forbidden");
      return;
    }
    if (
      mode === "subscribe" &&
      typeof token === "string" &&
      typeof challenge === "string" &&
      challenge.length > 0 &&
      // Same length cap as the per-workspace handshake: Meta's challenge is a short
      // opaque string, so refusing >255 chars stops a misrouted client coaxing us
      // into echoing arbitrary text.
      challenge.length <= 255 &&
      timingSafeEqualString(token, expected)
    ) {
      res.status(200).type("text/plain").send(challenge);
      return;
    }
    res.status(403).type("text/plain").send("forbidden");
  }

  /**
   * APP-LEVEL inbound (`POST /webhooks/meta`, no workspaceId in the path).
   *
   * Required for Embedded Signup, not optional: Meta delivers every onboarded
   * customer's webhooks to the APP's callback URL, and per-WABA / per-number
   * `override_callback_uri` cannot cover template webhooks
   * (`message_template_status_update`, `_quality_update`, `_components_update`,
   * `template_category_update`) or account webhooks (`account_update`,
   * `account_review_update`, `account_alerts`) — those are ALWAYS sent here.
   *
   * ORDER IS LOAD-BEARING: verify the HMAC against the platform app secret FIRST,
   * then resolve the tenant from the now-trusted payload. Resolving first would let
   * an unauthenticated body drive DB lookups — a workspace-enumeration oracle and a
   * DoS lever. The per-workspace route can lean on its path param as a routing
   * signal; here there is no path, so the signature is the only authority.
   */
  @Post()
  @HttpCode(200)
  async receiveAppLevel(
    @Headers("x-hub-signature-256") signature: string | undefined,
    @Req() req: Request,
  ): Promise<{ ok: boolean; ingested?: number; dropped?: string }> {
    if (!appLevelWebhookEnabled()) {
      // Unconfigured platform app. 200-drop rather than 403: if Meta ever points
      // here before we're ready, a non-2xx would start a retry storm.
      return { ok: true, ingested: 0, dropped: "app_level_not_configured" };
    }

    const channel = channelForMetaObject(req.body);
    if (!channel) return { ok: true, ingested: 0, dropped: "unsupported_object" };

    const rawBody = rawBodyOf(req);
    if (!rawBody) {
      this.logger.error(
        "[app-level] webhook missing rawBody — returning 200 to avoid retry storm",
      );
      return { ok: true, ingested: 0, dropped: "missing_raw_body" };
    }

    // ── AUTHENTICATION. Nothing above this line touched the database. ────────
    if (!insecureSkipVerify(this.logger)) {
      if (!signature) {
        throw new HttpException({ error: "forbidden", detail: "no_signature" }, 403);
      }
      if (!verifySignature(rawBody, signature, platformAppSecrets())) {
        this.logger.warn("[app-level] bad signature — dropping");
        throw new HttpException({ error: "forbidden", detail: "bad_signature" }, 403);
      }
    }

    wireIn(channel, rawBody.toString("utf8"));
    const payload = req.body as unknown;

    // ── The payload is now trusted; attribute each ENTRY to its own tenant. ──
    //
    // PER-ENTRY, not per-body. Meta batches up to 1000 updates per POST and the
    // reference is explicit that "Multiple changes from different objects that are
    // of the same type may be batched together" — for `whatsapp_business_account`
    // those objects are different WABAs, so under a Tech Provider app one POST can
    // carry two customers. Collapsing the body to a single workspace made such a
    // body `ambiguous` and dropped ALL of it, including the entries that resolved
    // cleanly — and because a drop answers 200 (deliberate, see below), Meta never
    // redelivered them.
    const grouping = await groupEntriesByWorkspace(channel, payload);

    // Never guess: an entry whose ids map to several workspaces is dropped rather
    // than attributed to one of the candidates, which would be a cross-tenant
    // leak. Only that entry is lost now — not its batch-mates.
    for (const miss of grouping.unattributed) {
      this.logger.warn(
        `[app-level] dropped ${channel} entry ${miss.entryId ?? "<no id>"}: ` +
          (miss.reason === "ambiguous" ? (miss.detail ?? "ambiguous") : "no matching workspace"),
      );
    }

    if (grouping.groups.length === 0) {
      const anyAmbiguous = grouping.unattributed.some((m) => m.reason === "ambiguous");
      return {
        ok: true,
        ingested: 0,
        dropped: anyAmbiguous ? "workspace_ambiguous" : "unknown_workspace",
      };
    }

    let ingested = 0;
    let rateLimited = 0;
    for (const group of grouping.groups) {
      // PER-WORKSPACE rate limiting, consumed HERE rather than in the guard. The
      // guard keys on the `workspaceId` path param and falls back to the client IP —
      // and on this route every tenant shares Meta's IP set, so that fallback would
      // collapse every workspace into ONE global bucket: a cross-tenant self-DoS
      // where one busy customer throttles everybody. The tenant isn't knowable
      // until now, so the fair bucket has to be consumed after resolution.
      //
      // Now consumed per GROUP: one tenant exhausting its bucket must not throttle
      // a co-batched tenant, so a 429 here skips that group instead of failing the
      // whole request.
      const rate = appLevelWorkspaceBucket.consume(`team:${group.workspaceId}`);
      if (!rate.ok) {
        rateLimited += 1;
        this.logger.warn(
          `[app-level] rate-limited ${channel} group for workspace ${group.workspaceId} ` +
            `(${group.entryCount} entr${group.entryCount === 1 ? "y" : "ies"})`,
        );
        continue;
      }
      // Sequential, like `groupEventsByInboundAccount`'s consumers: ingest
      // serialises per contact internally, and a 1000-update batch fanned out
      // concurrently would multiply DB load for no latency benefit on a single VPS.
      const res =
        channel === "whatsapp"
          ? await this.ingest.ingestWhatsappPayload(group.workspaceId, group.payload)
          : await this.ingest.ingestSocialPayload(group.workspaceId, channel, group.payload);
      ingested += res.ingested ?? 0;
    }

    // Every group throttled and nothing ingested — say so with a 429 so Meta
    // retries, rather than reporting a silent success.
    if (ingested === 0 && rateLimited > 0) {
      throw new HttpException(
        {
          error: "rate_limited",
          detail: "Too many webhooks for this workspace in the last minute.",
        },
        429,
      );
    }

    return { ok: true, ingested };
  }

  @Get(":workspaceId")
  async verify(
    @Param("workspaceId") workspaceId: string,
    @Query("hub.mode") mode: string | undefined,
    @Query("hub.verify_token") token: string | undefined,
    @Query("hub.challenge") challenge: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // The one callback verifies every Meta product the team connected, so
    // accept the challenge if the token matches ANY of the team's channel
    // verify tokens. We can't know the channel from a verify GET (it carries
    // only mode/token/challenge), so check each. Read the raw tokens — NOT the
    // full webhook config — so a callback can be verified in Meta before the
    // connection is fully wired (Meta's natural setup order: verify first, add
    // the app secret + send credentials after). The POST path independently
    // requires the app secret, so honoring a token here grants no access.
    const verifyTokens = await getTeamVerifyTokens(workspaceId);
    if (verifyTokens.length === 0) {
      // Silent 403 — leaking "team unconfigured" vs "team not found" gives
      // attackers a workspaceId enumeration oracle on a public endpoint.
      res.status(403).type("text/plain").send("forbidden");
      return;
    }
    // Timing-safe compare on the verify token + a length sanity cap on the
    // echoed challenge. Meta's challenge values are short opaque strings (~32
    // chars); refusing >255 chars stops a misrouted client from coaxing us
    // into echoing arbitrary text.
    if (
      mode === "subscribe" &&
      typeof token === "string" &&
      typeof challenge === "string" &&
      challenge.length > 0 &&
      challenge.length <= 255 &&
      verifyTokens.some((vt) => timingSafeEqualString(token, vt))
    ) {
      res.status(200).type("text/plain").send(challenge);
      return;
    }
    res.status(403).type("text/plain").send("forbidden");
  }

  @Post(":workspaceId")
  @HttpCode(200)
  async receive(
    @Param("workspaceId") workspaceId: string,
    @Headers("x-hub-signature-256") signature: string | undefined,
    @Req() req: Request,
  ): Promise<{ ok: boolean; ingested?: number; dropped?: string }> {
    // Fan out by the webhook `object` (Meta delivers all products to one
    // callback). Messenger has its own isolated path; anything unsupported
    // (e.g. a future `instagram` object before its provider ships) is dropped
    // softly so Meta doesn't retry-storm. WhatsApp falls through to the
    // existing, byte-identical path below.
    const channel = channelForMetaObject(req.body);
    if (channel === "messenger" || channel === "instagram") {
      return this.receiveSocial(workspaceId, signature, req, channel);
    }
    if (channel !== "whatsapp") {
      return { ok: true, ingested: 0, dropped: "unsupported_object" };
    }

    const config = await getMetaWebhookConfig(workspaceId);
    if (!config) throw webhookForbidden(this.logger, workspaceId, "whatsapp", req, "no_config");

    // Verify against the EXACT bytes Meta signed. main.ts's bodyParser
    // captures req.rawBody on every JSON-parsed request. Without it,
    // JSON.stringify(req.body) would silently invalidate the HMAC on any
    // whitespace difference.
    const rawBody = rawBodyOf(req);
    if (!rawBody) {
      // Fail SOFT — Meta retries on any non-2xx and a 500 here would put
      // us in an infinite retry storm if a future middleware reordering
      // or content-type drift breaks the verify hook. Log loudly so the
      // regression is discoverable, but return 200 to bound the damage.
      this.logger.error(
        `[${workspaceId}] missing rawBody — main.ts verify hook regressed? returning 200 to avoid retry storm`,
      );
      return { ok: true, ingested: 0, dropped: "missing_raw_body" };
    }
    if (!insecureSkipVerify(this.logger)) {
      if (!signature) throw webhookForbidden(this.logger, workspaceId, "whatsapp", req, "no_signature");
      const cands = [config.appSecret, ...config.appSecretFallbacks];
      if (!verifySignature(rawBody, signature, cands)) {
        logSignatureDiag(this.logger, signature, rawBody, cands);
        throw webhookForbidden(this.logger, workspaceId, "whatsapp", req, "bad_signature");
      }
    }

    // Dev wire log (DEBUG_META_WIRE): the authentic raw webhook, so you can see
    // EXACTLY what Meta sent. After verify so we never log a forged body.
    wireIn(channel, rawBody.toString("utf8"));

    // Body is already parsed by main.ts's bodyParser.json — req.body has it.
    return this.ingest.ingestWhatsappPayload(workspaceId, req.body as unknown);
  }

  /**
   * Meta SOCIAL inbound path (Messenger `object:"page"` / Instagram
   * `object:"instagram"`). Same HMAC + fail-soft posture as the WhatsApp path,
   * but simpler: no phone-number mismatch guard, no Coexistence history, and
   * (this increment) no inbound media download — text + delivery status only.
   * Everything below the parser (`ingestEvents`) is channel-generic, so a
   * social contact/conversation/message flows through the exact same pipeline
   * as WhatsApp.
   */
  private async receiveSocial(
    workspaceId: string,
    signature: string | undefined,
    req: Request,
    channel: "messenger" | "instagram",
  ): Promise<{ ok: boolean; ingested?: number; dropped?: string }> {
    const { getWebhookConfig } = SOCIAL[channel];
    const config = await getWebhookConfig(workspaceId);
    if (!config) throw webhookForbidden(this.logger, workspaceId, channel, req, "no_config");

    const rawBody = rawBodyOf(req);
    if (!rawBody) {
      this.logger.error(
        `[${workspaceId}] ${channel} webhook missing rawBody — returning 200 to avoid retry storm`,
      );
      return { ok: true, ingested: 0, dropped: "missing_raw_body" };
    }
    if (!insecureSkipVerify(this.logger)) {
      if (!signature) throw webhookForbidden(this.logger, workspaceId, channel, req, "no_signature");
      const cands = [config.appSecret, ...config.appSecretFallbacks];
      if (!verifySignature(rawBody, signature, cands)) {
        logSignatureDiag(this.logger, signature, rawBody, cands);
        throw webhookForbidden(this.logger, workspaceId, channel, req, "bad_signature");
      }
    }

    // Dev wire log (DEBUG_META_WIRE): the authentic raw social webhook.
    wireIn(channel, rawBody.toString("utf8"));

    return this.ingest.ingestSocialPayload(workspaceId, channel, req.body as unknown);
  }

}

// `withMediaDownloadSlot`, `fetchUrlBytes` and `readBodyCapped` moved to
// `@/lib/media-capture` when the outbound sticker send became a second caller.
// `fetchUrlBytes` is the SSRF gate on a webhook-supplied URL, and a second copy
// of a security control is one copy that drifts — see that module's header.

function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  // One or more candidate secrets. A channel may be verifiable by EITHER the
  // shared Meta App secret OR its own stored secret (when it's connected to a
  // different Meta app than the shared one). Accept if ANY candidate matches —
  // every candidate is a secret the team itself configured, so this never
  // widens trust beyond the team's own apps.
  secret: string | ReadonlyArray<string | undefined>,
): boolean {
  if (!header) return false;
  const b = Buffer.from(header);
  const candidates = typeof secret === "string" ? [secret] : secret;
  for (const s of candidates) {
    if (!s) continue;
    const expected = "sha256=" + createHmac("sha256", s).update(rawBody).digest("hex");
    const a = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * DEV-ONLY escape hatch: skip inbound webhook HMAC verification so local testing
 * over a tunnel never drops an event to a signature mismatch. HARD prod gate —
 * always false when NODE_ENV=production. Opt in with
 * META_WEBHOOK_INSECURE_SKIP_VERIFY=1 (in the root .env). Warns ONCE so it can
 * never be silently on. This is a crutch to unblock local dev, NOT a fix — a
 * wrong app secret drops webhooks in production too, so fix the secret.
 */
let insecureSkipWarned = false;
function insecureSkipVerify(logger: Logger): boolean {
  if (process.env.META_WEBHOOK_INSECURE_SKIP_VERIFY !== "1") return false;
  if (process.env.NODE_ENV === "production") return false;
  if (!insecureSkipWarned) {
    insecureSkipWarned = true;
    logger.warn(
      "META_WEBHOOK_INSECURE_SKIP_VERIFY is ON — inbound webhook signatures are NOT verified (dev only). Never enable in production.",
    );
  }
  return true;
}

/**
 * Build the 403 for a rejected webhook AND log WHY (bare "forbidden" is
 * un-debuggable). A rejected body never reaches the after-verify `wireIn`, so
 * with DEBUG_META_WIRE on we surface it here too — this is how you see the
 * webhooks Meta sent that we're dropping.
 */
function webhookForbidden(
  logger: Logger,
  workspaceId: string,
  channel: Channel,
  req: Request,
  reason: "no_config" | "no_signature" | "bad_signature",
): HttpException {
  const objectType =
    (req.body as { object?: string } | null | undefined)?.object ?? "?";
  const hint =
    reason === "bad_signature"
      ? "X-Hub-Signature-256 didn't match this channel's stored app secret — re-check the secret in onboarding, or the same callback URL is subscribed under a DIFFERENT Meta app (each app signs with its own secret)."
      : reason === "no_config"
        ? "no webhook config for this team+channel."
        : "Meta sent no signature header.";
  logger.warn(`[${workspaceId}] ${channel} webhook 403 — ${reason} (object=${objectType}): ${hint}`);
  const rawBody = rawBodyOf(req);
  if (rawBody) wireIn(`${channel} REJECTED (${reason})`, rawBody.toString("utf8"));
  return new HttpException("forbidden", 403);
}

/**
 * DEBUG_META_WIRE aid for a bad_signature: print the received signature next to
 * what each STORED secret would produce over these exact bytes. If `received`
 * matches none of the expected values, the stored app secret is simply the wrong
 * value — paste the correct one. For Instagram that is the "Instagram app secret"
 * in the app's Instagram product settings, which is a DIFFERENT value from the
 * Facebook "App Secret" (Settings → Basic). These are HMAC digests (not the
 * secret itself), and only a prefix is shown.
 */
function logSignatureDiag(
  logger: Logger,
  signature: string | undefined,
  rawBody: Buffer,
  candidates: ReadonlyArray<string | undefined>,
): void {
  if (!metaWireEnabled()) return;
  const expected = candidates
    .filter((s): s is string => !!s)
    .map(
      (s, i) =>
        `secret#${i + 1}→${createHmac("sha256", s).update(rawBody).digest("hex").slice(0, 20)}…`,
    );
  const recv = (signature ?? "(none)").replace(/^sha256=/, "").slice(0, 20);
  logger.warn(
    `  ↳ sig diag: received=${recv}…  expected=[ ${expected.join("  ")} ]  ` +
      `— ${expected.length} stored secret(s) tried; matches none ⇒ the stored secret is wrong ` +
      `(Instagram uses the "Instagram app secret", not the Facebook App Secret).`,
  );
}

/**
 * Constant-time string compare. Used by the verify-token handshake so a
 * remote prober can't time-difference the prefix of the expected token.
 * Both inputs are coerced to fixed-length Buffers; the length-mismatch
 * branch is a precondition of `timingSafeEqual` (which throws on unequal
 * lengths) — comparing a zero-padded buffer instead would just hide the
 * length leak without preventing it.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
