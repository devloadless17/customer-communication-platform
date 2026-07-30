/**
 * Meta error codes are not context-free: the same number can mean different
 * things on a synchronous send response than on a status webhook.
 *
 * `135000` is the case that bit us. Meta documents it twice:
 *
 *   - Error codes reference (SYNCHRONOUS responses, HTTP 400): "Generic user
 *     error — Message failed to send because of an unknown error with your
 *     request parameters."
 *   - Business portfolio pacing (STATUS WEBHOOKS): "all remaining held messages
 *     will be dropped, and a status messages webhook with status set to failed and
 *     code set to 135000 will be triggered for each dropped message."
 *
 * We applied the pacing reading to BOTH. So an operator whose request had a bad
 * parameter was told their portfolio was "paused from sending and creating
 * templates while Meta reviews recent activity" and pointed at Business Suite to
 * appeal — an enforcement that never happened — while the actual malformed
 * parameter went undiagnosed.
 *
 * The split is now structural: `normalizeMetaSendError` handles send exceptions,
 * `classifyMetaStatusError` handles webhook codes, and only the latter knows about
 * pacing.
 *
 *   pnpm --filter @ccp/api exec vitest run test/meta-error-context.spec.ts
 */
import { describe, expect, it } from "vitest";

import {
  MetaSendError,
  classifyMetaStatusError,
  normalizeMetaSendError,
} from "@/lib/providers/meta-send-error";

/** A synchronous Meta rejection, shaped the way the send path throws it. */
function sendError(code: number, details = "something about parameters"): unknown {
  const body = JSON.stringify({
    error: {
      message: `(#${code}) Generic user error`,
      type: "OAuthException",
      code,
      error_data: { messaging_product: "whatsapp", details },
    },
  });
  return new MetaSendError(`meta send failed: 400 ${body}`, 400, body);
}

describe("135000 — same code, two meanings", () => {
  it("on a STATUS WEBHOOK it is a portfolio pacing drop", () => {
    expect(classifyMetaStatusError(135000)).toBe("portfolio_paced_drop");
  });

  it("on a SYNCHRONOUS send it is NOT a pacing drop", () => {
    const out = normalizeMetaSendError(sendError(135000));
    expect(out?.code).not.toBe("portfolio_paced_drop");
  });

  it("and it never claims a portfolio enforcement that did not happen", () => {
    // The specific damage: sending someone to Business Suite to appeal nothing.
    const out = normalizeMetaSendError(sendError(135000));
    const text = `${out?.message ?? ""}`;
    expect(text).not.toMatch(/portfolio/i);
    expect(text).not.toMatch(/appeal/i);
    expect(text).not.toMatch(/Business Suite/i);
  });
});

describe("codes that genuinely are webhook-only stay webhook-only", () => {
  it("per-user marketing cap (131049) classifies on the webhook path", () => {
    // Meta only ever reports this AFTER accepting the send, so the webhook is the
    // only place it can be observed.
    expect(classifyMetaStatusError(131049)).toBe("per_user_marketing_cap");
  });

  it("marketing opt-out (131050) classifies on the webhook path", () => {
    expect(classifyMetaStatusError(131050)).toBe("marketing_opt_out");
  });
});

describe("codes that are the same in both contexts", () => {
  it("template paused (132015) is template_unavailable either way", () => {
    // A paced template's dropped messages arrive as 132015 on the webhook, and a
    // send attempted against an already-paused template is rejected with it
    // synchronously. Both mean the template can't be used — same guidance.
    expect(classifyMetaStatusError(132015)).toBe("template_unavailable");
    expect(normalizeMetaSendError(sendError(132015))?.code).toBe("template_unavailable");
  });

  it("outside the 24h window (131047) is the same either way", () => {
    expect(classifyMetaStatusError(131047)).toBe("outside_24h_window");
    expect(normalizeMetaSendError(sendError(131047))?.code).toBe("outside_24h_window");
  });

  it("an unknown code falls back rather than guessing", () => {
    expect(classifyMetaStatusError(999999)).toBe("provider_rejected");
    expect(normalizeMetaSendError(sendError(999999))?.code).toBe("provider_rejected");
  });
});
