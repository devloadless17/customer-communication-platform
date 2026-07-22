import { resolveFieldTokens } from "@ccp/shared/field-tokens";

import { decryptSecret } from "@/lib/crypto/envelope";
import { safeFetch, SsrfBlockedError, readLimitedBody } from "@/lib/http/safe-fetch";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advanceWithError,
  envelopeContact,
  truncateBody,
} from "./types";
import { buildTokenContext } from "./token-context";

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

// Sentinel a redacted custom-header VALUE is replaced with before the config
// is sent to the UI (header NAMES stay visible so the admin sees which headers
// are configured). On a subsequent PATCH the secret-merge in workflows.service
// treats an incoming value equal to this sentinel as "unchanged — restore the
// stored encrypted value." Same preserve-when-omitted contract the bearerToken
// already uses, just per header key. Exported so the merge AND the canvas
// editor (which shows it as the saved-placeholder) stay in lockstep. Chosen to
// round-trip cleanly through the editor's `Name: value` textarea.
export const REDACTED_HEADER_VALUE = "•••••••• (saved)";

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
    if (config.customHeaders) {
      // Header VALUES are secrets (X-API-Key, custom Authorization, …) — same
      // class as bearerToken — so never echo them back. Keep the NAMES so the
      // admin sees which headers exist, and replace each value with a sentinel
      // the PATCH secret-merge restores from the stored ciphertext.
      out.customHeaders = Object.fromEntries(
        Object.keys(config.customHeaders).map((k) => [k, REDACTED_HEADER_VALUE]),
      );
    }
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

    // Full token context (complete contact + sender) so URL / token / header
    // values can use every namespace the editor offers — `$var.contact.*`
    // incl. stage_name / tag_names, `$var.sender.*`, `$var.message.*`,
    // `$var.previousStep.*`, `$var.steps.*`.
    const { contact, extras } = await buildTokenContext(
      envelope,
      ctx,
      ctx.workspaceId,
      envelopeContact(envelope)?.id,
    );
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
    // Custom-header VALUES are envelope-encrypted at rest (same as bearerToken;
    // see encryptGraphStepSecrets). Decrypt each — decryptSecret() is a no-op
    // for plaintext so legacy graphs written before this rollout keep working —
    // THEN resolve `$var.*` tokens, matching the bearerToken order above.
    let resolvedHeaders: Record<string, string> | undefined;
    if (config.customHeaders) {
      resolvedHeaders = {};
      for (const [k, v] of Object.entries(config.customHeaders)) {
        let plaintextValue: string;
        try {
          plaintextValue = decryptSecret(v);
        } catch {
          return advanceWithError(
            500,
            `http_request custom header "${k}" could not be decrypted (key rotated?)`,
          );
        }
        resolvedHeaders[k] = resolveFieldTokens(plaintextValue, contact, extras);
      }
    }

    // Cross-system loop guard: stamp the incremented chain depth so that if
    // this call lands on a system that bounces back into our own
    // incoming_webhook, that handler can cap the cycle. Custom headers can't
    // override it — spread first, then set X-CCP-Depth last.
    const nextDepth = (envelope.depth ?? 0) + 1;

    // Cap envelope body at 256 KB. For a message_received trigger the
    // envelope carries `recentMessages` (configurable but ~50 by default)
    // plus contact + conversation snapshots — on a noisy thread with
    // media payloads JSON.stringify can easily hit 100KB+ and a
    // misconfigured slow-receiver pinned at the 30s timeout would chew
    // 3 retries × 30s before advancing. Refuse-loud with a 413 ADVANCE
    // (not throw — partner-side fix is to either tighten the recentMessages
    // window or filter the customFields they don't need). Cap is
    // checked AFTER stringify rather than estimated up-front because
    // contact.customFields is the dominant unbounded surface and pre-
    // estimating it accurately costs as much as stringifying.
    const serializedBody = JSON.stringify(envelope);
    const MAX_ENVELOPE_BYTES = 256 * 1024;
    const envelopeBytes = Buffer.byteLength(serializedBody, "utf8");
    if (envelopeBytes > MAX_ENVELOPE_BYTES) {
      return advanceWithError(
        413,
        `http_request envelope too large (${envelopeBytes} bytes > ${MAX_ENVELOPE_BYTES} cap)`,
        "Trim the trigger's recentMessages window or remove unused customFields.",
      );
    }

    let res: Response;
    try {
      res = await safeFetch(resolvedUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "ccp-workflows/1",
          ...(resolvedToken ? { Authorization: `Bearer ${resolvedToken}` } : {}),
          ...(resolvedHeaders ?? {}),
          // Idempotency key STABLE across BullMQ retries (runId + stepId +
          // executionIndex don't change on retry; only `attempt` does) but
          // DISTINCT per jump_to_step re-entry (executionIndex increments). This
          // step is sideEffect:"pure" — the runner does NOT journal it, so a
          // transient failure / slow (>timeout) response re-runs the job and
          // re-POSTs; without a stable key the partner can't dedupe → double
          // charge/ticket. WITHOUT executionIndex a clarifier loop (…→ notify →
          // jump back → notify) re-POSTs with the SAME key, so a partner deduping
          // on it silently drops every iteration after the first. Set AFTER the
          // custom-header spread so a partner can't override it.
          "X-CCP-Delivery": `${ctx.runId}:${ctx.stepId}:${ctx.executionIndex}`,
          "X-CCP-Depth": String(nextDepth),
        },
        body: serializedBody,
        timeoutMs: timeout,
        // We only keep the first 16 KB (readLimitedBody below) — tell safeFetch
        // to buffer at most that, so a huge/hostile response is torn off the
        // socket instead of buffering up to the 16 MB hard cap first.
        maxResponseBytes: 16_384,
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError && !err.transient) {
        // Permanent block (private/blocked range) — don't retry. Treat like a
        // 4xx so the run advances past this step with the error logged, rather
        // than burning BullMQ backoff cycles on an address that won't resolve
        // any differently next attempt.
        return advanceWithError(400, "http_request blocked", err.reason);
      }
      // A TRANSIENT SsrfBlockedError (e.g. `dns-failure` — not-yet-propagated
      // DNS for a healthy public host) must behave like any other transient
      // network error: fall through to the throw below so BullMQ retries with
      // backoff, matching the outbound-webhook worker's classification.
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
