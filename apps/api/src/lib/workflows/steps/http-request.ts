import { type ContactLike, resolveFieldTokens } from "@ccp/shared/field-tokens";

import { decryptSecret } from "@/lib/crypto/envelope";
import { safeFetch, SsrfBlockedError, readLimitedBody } from "@/lib/http/safe-fetch";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advanceWithError,
  envelopeContact,
  envelopeExtras,
  truncateBody,
} from "./types";

/**
 * `http_request` step. Direct port of the legacy `webhook` action: POSTs
 * the envelope to a user-provided URL, with bearer-token + custom-header
 * support, and resolves `$var.contact.*` tokens in the URL / token /
 * header values.
 *
 *   Config: { url, bearerToken?, customHeaders?, timeoutMs? }
 */

// Hard cap on per-step timeout (any step kind, not just http_request).
// `worker.ts` asserts `lockDuration > MAX_STEP_TIMEOUT_MS + 10_000` on boot
// so a step that runs to its full budget cannot outlive its BullMQ lock and
// get re-delivered while still in flight. Raising this here without bumping
// `lockDuration` will fail the boot assertion — by design.
export const MAX_STEP_TIMEOUT_MS = 60_000;

export interface HttpRequestStepConfig {
  url: string;
  bearerToken?: string;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export const httpRequestStepHandler: StepHandler<HttpRequestStepConfig> = {
  type: "http_request",
  // "pure" from the runner's idempotency-journaling perspective: the
  // CALLEE (the partner endpoint) is expected to dedupe at-least-once
  // delivery via the X-CCP-Delivery header. From this process's POV the
  // step is a black-box HTTP call — same as a wait/branch in that we
  // don't journal it and let BullMQ's retry semantics handle redelivery.
  sideEffect: "pure",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("http_request config must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.url !== "string" || !/^https?:\/\//i.test(r.url)) {
      throw new StepConfigError("http_request.url must be an http(s) URL");
    }
    const cfg: HttpRequestStepConfig = { url: r.url };
    if (typeof r.bearerToken === "string" && r.bearerToken.length > 0) {
      cfg.bearerToken = r.bearerToken;
    }
    if (r.customHeaders && typeof r.customHeaders === "object" && !Array.isArray(r.customHeaders)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.customHeaders as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      if (Object.keys(out).length > 0) cfg.customHeaders = out;
    }
    if (typeof r.timeoutMs === "number" && r.timeoutMs > 0 && r.timeoutMs <= MAX_STEP_TIMEOUT_MS) {
      cfg.timeoutMs = r.timeoutMs;
    }
    return cfg;
  },
  redactConfig(config) {
    const out: Record<string, unknown> = { url: config.url };
    if (config.bearerToken) out.bearerTokenSet = true;
    if (config.customHeaders) out.customHeaders = config.customHeaders;
    if (config.timeoutMs) out.timeoutMs = config.timeoutMs;
    return out;
  },
  describeConfig(c) {
    return `POST ${c.url}`;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    // 30s default. Real customer APIs (CRMs, billing systems, data
    // enrichment) routinely take 5-20s on cold paths. The previous 8s
    // default tripped legitimate slow endpoints into BullMQ retries, and
    // retry on a slow-but-working endpoint is a poor outcome (it can
    // double-post side effects on the customer side). Per-step config can
    // still cap lower for endpoints known to be fast (validated <= 60s in
    // the parseConfig above).
    const timeout = config.timeoutMs ?? 30_000;

    const envC = envelopeContact(envelope);
    const contact: ContactLike = envC
      ? {
          name: envC.name,
          phoneNumber: envC.phoneNumber,
          email: envC.email,
          location: null,
          customFields: envC.customFields,
        }
      : { name: "", phoneNumber: null, email: null, location: null, customFields: {} };

    // Full token context so URL / token / header values can use the same
    // namespaces the editor offers — `$var.sender.*`, `$var.message.*`,
    // `$var.previousStep.*`, `$var.steps.*` — not just `$var.contact.*`.
    const extras = envelopeExtras(envelope, ctx);
    const resolvedUrl = resolveFieldTokens(config.url, contact, extras);
    // bearerToken is envelope-encrypted at rest (workflows.service ->
    // encryptGraphStepSecrets). decryptSecret() is a no-op for plaintext
    // so legacy graphs from before this rollout keep working unchanged.
    let plaintextToken: string | undefined;
    if (config.bearerToken) {
      try {
        plaintextToken = decryptSecret(config.bearerToken);
      } catch {
        return advanceWithError(
          500,
          "http_request bearerToken could not be decrypted (key rotated?)",
        );
      }
    }
    const resolvedToken = plaintextToken
      ? resolveFieldTokens(plaintextToken, contact, extras)
      : undefined;
    const resolvedHeaders = config.customHeaders
      ? Object.fromEntries(
          Object.entries(config.customHeaders).map(([k, v]) => [k, resolveFieldTokens(v, contact, extras)]),
        )
      : undefined;

    // Cross-system loop guard: stamp the incremented chain depth so that if
    // this call lands on a system that bounces back into our own
    // incoming_webhook, that handler can cap the cycle. Custom headers can't
    // override it — spread first, then set X-CCP-Depth last.
    const nextDepth = (envelope.depth ?? 0) + 1;

    let res: Response;
    try {
      res = await safeFetch(resolvedUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "ccp-workflows/1",
          ...(resolvedToken ? { Authorization: `Bearer ${resolvedToken}` } : {}),
          ...(resolvedHeaders ?? {}),
          "X-CCP-Depth": String(nextDepth),
        },
        body: JSON.stringify(envelope),
        timeoutMs: timeout,
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        // Permanent — don't retry. Treat like a 4xx so the run advances past
        // this step with the error logged, rather than burning BullMQ
        // backoff cycles on an address that won't resolve any differently
        // next attempt.
        return advanceWithError(400, "http_request blocked", err.reason);
      }
      // Network / timeout — throw so BullMQ retries with backoff.
      throw new Error(`http_request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const raw = (await readLimitedBody(res, 16_384)) ?? "";
    const body = truncateBody(raw);

    if (res.status >= 500) {
      throw new Error(`http_request returned ${res.status}: ${body}`);
    }
    return { kind: "advance", status: res.status, body };
  },
};
