// Note: no `server-only` import — pulled in by the BullMQ worker which boots
// from server.ts, outside the Next bundler context.

import type { AutomationActionType } from "@prisma/client";

import type { AutomationWebhookEnvelope } from "@/lib/automations/events";

/**
 * Webhook action handler.
 *
 * POSTs the trigger envelope to a user-provided URL. Returns a result the
 * runner persists to AutomationRun. We don't retry here — BullMQ owns the
 * retry policy, so a thrown error bubbles back to the worker.
 *
 * `bearerToken` is a static token (per CLAUDE.md/user choice). We don't sign
 * the payload; if the user lost their token, rotate by editing the rule.
 */

export interface WebhookActionConfig {
  url: string;
  bearerToken?: string;
  customHeaders?: Record<string, string>;
  /** Defaults to 8000ms. n8n itself can take a few seconds to spin up nodes. */
  timeoutMs?: number;
}

export class ActionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionConfigError";
  }
}

/** Validate the JSON blob loaded from Automation.actionConfig. Throws on garbage. */
export function parseWebhookConfig(raw: unknown): WebhookActionConfig {
  if (!raw || typeof raw !== "object") {
    throw new ActionConfigError("webhook config must be an object");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== "string" || !/^https?:\/\//i.test(r.url)) {
    throw new ActionConfigError("webhook url must be an http(s) URL");
  }
  const cfg: WebhookActionConfig = { url: r.url };
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
}

export interface WebhookActionResult {
  status: number;
  /** Truncated to ~2KB so a verbose error page doesn't bloat the DB. */
  body: string;
}

/** Fired by the runner. Throws on network/timeout/5xx so BullMQ retries; returns on 2xx/3xx/4xx. */
export async function runWebhookAction(
  envelope: AutomationWebhookEnvelope,
  config: WebhookActionConfig,
): Promise<WebhookActionResult> {
  const timeout = config.timeoutMs ?? 8000;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);

  let res: Response;
  try {
    res = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "ccp-automations/1",
        ...(config.bearerToken ? { Authorization: `Bearer ${config.bearerToken}` } : {}),
        ...(config.customHeaders ?? {}),
      },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(t);
    // Network error / timeout → throw so BullMQ retries with backoff.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`webhook fetch failed: ${msg}`);
  }
  clearTimeout(t);

  // Cap body to ~2KB. The action UI shows the response for debugging; we
  // don't want a 5MB HTML error page in every row.
  const raw = await res.text();
  const body = raw.length > 2048 ? raw.slice(0, 2048) + "…[truncated]" : raw;

  // 5xx → throw so BullMQ retries. 4xx → return — user config issue, no
  // point retrying. 2xx/3xx → return success.
  if (res.status >= 500) {
    throw new Error(`webhook returned ${res.status}: ${body}`);
  }
  return { status: res.status, body };
}

export const WEBHOOK_ACTION_TYPE = "webhook" satisfies AutomationActionType;
