import { describe, expect, it } from "vitest";

import {
  MetaSendError,
  isPairRateLimitBody,
  isPairRateLimitError,
  normalizeMetaSendError,
} from "@/lib/providers/meta-send-error";
import { sendBackoffDelayMs } from "@/messages/send-worker.service";

/**
 * WhatsApp pair rate limit (131056) — 1 msg/6s to the same (number, recipient),
 * ~45-message burst that borrows future quota.
 *
 * The code shares the `rate_limited` family (retry machinery must engage), but
 * its SCOPE is one recipient, not the number — so two behaviors depend on
 * telling it apart from 130429/131048/4/80007:
 *
 *  1. The broadcast runner must NOT feed it into the number-wide 429 streak /
 *     cross-lane pause / whole-run park — it defers the single recipient
 *     instead (lane loop `defer_pair_limit` handling in broadcast-runner.ts).
 *  2. The send worker's retry spacing must exceed the 6s token period —
 *     under the old flat 1.5s/3s schedule every retry landed inside the
 *     refill window and was guaranteed wasted.
 *
 * These specs pin the classification helpers and the backoff schedule those
 * behaviors are built on.
 */

const pairBody = JSON.stringify({
  error: {
    message: "(#131056) (Business Account, Consumer Account) pair rate limit hit",
    type: "OAuthException",
    code: 131056,
    fbtrace_id: "AbC123",
  },
});

const throughputBody = JSON.stringify({
  error: {
    message: "(#130429) Rate limit hit",
    type: "OAuthException",
    code: 130429,
    fbtrace_id: "AbC123",
  },
});

describe("isPairRateLimitBody / isPairRateLimitError", () => {
  it("detects 131056 in a JSON error body", () => {
    expect(isPairRateLimitBody(pairBody)).toBe(true);
    expect(isPairRateLimitError(new MetaSendError("rate limited", 400, pairBody))).toBe(true);
  });

  it("does NOT match the number-level rate-limit family", () => {
    // 130429 (throughput), 131048 (spam/quality), 4 / 80007 (app-level) are
    // number- or app-scoped: they MUST keep engaging the number-wide backoff.
    for (const code of [130429, 131048, 4, 80007]) {
      const body = JSON.stringify({ error: { code, message: "limit" } });
      expect(isPairRateLimitBody(body)).toBe(false);
      expect(isPairRateLimitError(new MetaSendError("rate limited", 400, body))).toBe(false);
    }
  });

  it("survives a truncated body via the regex fallback", () => {
    // normalized.detail is body.slice(0, 500) — a truncated JSON no longer
    // parses, and detection must fall back to the "code": regex.
    const truncated = pairBody.slice(0, pairBody.indexOf("fbtrace"));
    expect(isPairRateLimitBody(truncated)).toBe(true);
  });

  it("is false for null/empty bodies and non-Meta errors", () => {
    expect(isPairRateLimitBody(null)).toBe(false);
    expect(isPairRateLimitBody("")).toBe(false);
    expect(isPairRateLimitError(new Error("boom"))).toBe(false);
    expect(isPairRateLimitError(undefined)).toBe(false);
  });
});

describe("normalizeMetaSendError on 131056", () => {
  it("stays in the rate_limited family (retry machinery must engage)", () => {
    const norm = normalizeMetaSendError(new MetaSendError("rate limited", 400, pairBody));
    expect(norm?.code).toBe("rate_limited");
  });

  it("names the PAIR limit, not the account", () => {
    // The family message ("Meta is rate-limiting this account") sends an agent
    // hunting for an account problem that doesn't exist — the pair limit is
    // about ONE recipient being messaged too fast.
    const pair = normalizeMetaSendError(new MetaSendError("rate limited", 400, pairBody));
    const number = normalizeMetaSendError(new MetaSendError("rate limited", 400, throughputBody));
    expect(pair?.message).toMatch(/same person/i);
    expect(number?.message).toMatch(/account/i);
    expect(pair?.message).not.toBe(number?.message);
  });
});

describe("sendBackoffDelayMs (message-sends custom backoff)", () => {
  it("keeps the historical 1.5s exponential for non-pair errors", () => {
    // Byte-identical to the `{type:"exponential", delay:1500}` schedule the
    // queue always used: 1500 × 2^(n−1).
    const err = new MetaSendError("rate limited", 400, throughputBody);
    expect(sendBackoffDelayMs(1, err)).toBe(1_500);
    expect(sendBackoffDelayMs(2, err)).toBe(3_000);
    expect(sendBackoffDelayMs(1, new Error("network"))).toBe(1_500);
    expect(sendBackoffDelayMs(2, undefined)).toBe(3_000);
  });

  it("waits a full pair-limit token period (>6s) on 131056", () => {
    const raw = new MetaSendError("rate limited", 400, pairBody);
    expect(sendBackoffDelayMs(1, raw)).toBeGreaterThan(6_000);
    expect(sendBackoffDelayMs(2, raw)).toBeGreaterThan(6_000);
  });

  it("detects 131056 through the executor's HTTP re-wrap (detail carries the body)", () => {
    // messages.service re-throws Meta failures as UnprocessableEntityException
    // whose response.detail is the raw body slice — the worker sees THAT
    // shape, not MetaSendError. Duck-typed here exactly as the worker does.
    const wrapped = {
      getResponse: () => ({
        error: "rate_limited",
        status: 400,
        detail: pairBody.slice(0, 500),
      }),
    };
    expect(sendBackoffDelayMs(1, wrapped)).toBeGreaterThan(6_000);
    // The same wrap carrying a number-level body keeps the fast schedule.
    const wrappedNumber = {
      getResponse: () => ({
        error: "rate_limited",
        status: 400,
        detail: throughputBody.slice(0, 500),
      }),
    };
    expect(sendBackoffDelayMs(1, wrappedNumber)).toBe(1_500);
  });
});
