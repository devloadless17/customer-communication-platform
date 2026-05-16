import { type ContactLike, resolveFieldTokens } from "@/lib/field-tokens";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  envelopeContact,
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

export interface HttpRequestStepConfig {
  url: string;
  bearerToken?: string;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export const httpRequestStepHandler: StepHandler<HttpRequestStepConfig> = {
  type: "http_request",
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
    if (typeof r.timeoutMs === "number" && r.timeoutMs > 0 && r.timeoutMs <= 60_000) {
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
  async run(envelope, config): Promise<StepResult> {
    const timeout = config.timeoutMs ?? 8000;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout);

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

    const resolvedUrl = resolveFieldTokens(config.url, contact);
    const resolvedToken = config.bearerToken
      ? resolveFieldTokens(config.bearerToken, contact)
      : undefined;
    const resolvedHeaders = config.customHeaders
      ? Object.fromEntries(
          Object.entries(config.customHeaders).map(([k, v]) => [k, resolveFieldTokens(v, contact)]),
        )
      : undefined;

    let res: Response;
    try {
      res = await fetch(resolvedUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "ccp-workflows/1",
          ...(resolvedToken ? { Authorization: `Bearer ${resolvedToken}` } : {}),
          ...(resolvedHeaders ?? {}),
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(t);
      // Network / timeout — throw so BullMQ retries with backoff.
      throw new Error(`http_request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    clearTimeout(t);

    const raw = await res.text();
    const body = truncateBody(raw);

    if (res.status >= 500) {
      throw new Error(`http_request returned ${res.status}: ${body}`);
    }
    return { kind: "advance", status: res.status, body };
  },
};
