/**
 * A BROADCAST MUST NEVER CLAIM THE HUMAN AGENT TAG.
 *
 * This is an account-safety rule, not a delivery preference, and the penalty for
 * getting it wrong lands on the CUSTOMER'S Instagram/Facebook account rather than
 * on us.
 *
 * Meta grants `HUMAN_AGENT` so that "a human agent [can] respond to a person's
 * messages within a 7-day period", and is explicit about the limits: "Message
 * Tags may not be used to send promotional content, including but not limited to:
 * deals, offers, coupons, and discounts", and "Use of Message Tags outside the
 * approved use cases may result in restrictions on the Page or Instagram
 * account's ability to send messages."
 *
 * A broadcast is bulk outbound by construction — nobody is answering anyone's
 * inquiry — so tagging one HUMAN_AGENT is misuse in the ordinary case. We cannot
 * classify message content, so we cannot judge "promotional" campaign by
 * campaign; what we CAN do is refuse to make the claim in the one place it is
 * never true. Out-of-window recipients are skipped instead.
 *
 * The complement matters just as much and is asserted here too: an AGENT-TYPED
 * reply keeps the tag, because there a human agent really is responding to that
 * person's own message — the approved use. Removing it there would silently drop
 * legitimate support replies in the 24h-7d band.
 *
 *   pnpm --filter @ccp/api exec vitest run test/broadcast-tag-safety.spec.ts
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { computeWindowStatus, effectiveSendWindowMs } from "@ccp/shared/utils/window";
import { normalizeMetaSendError } from "@/lib/providers/meta-send-error";
import { MetaSendError } from "@/lib/providers/meta-send-error";
import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";

const RUNNER = readFileSync("src/lib/broadcast-runner.ts", "utf8");

describe("the runner's fire-time window guard covers EVERY channel", () => {
  it("no longer exempts social from the freeform window check", () => {
    // The guard used to read `if (isFreeform && dialsPhone)`, which let every
    // out-of-window Messenger/Instagram recipient fall through to the tag. The
    // phone-only condition must be gone.
    expect(RUNNER).not.toContain("isFreeform && dialsPhone");
    expect(RUNNER).toContain("if (isFreeform) {");
  });

  it("explains WHY in the code, so the exemption is not re-added as an optimisation", () => {
    // A future reader looking at "social skips its own window check" would
    // reasonably restore it to widen reach. The reason it must not be restored is
    // the customer's account standing, and that has to be written where the
    // change would be made.
    expect(RUNNER).toMatch(/HUMAN_AGENT/);
    expect(RUNNER).toMatch(/restrictions on the Page or Instagram/);
  });
});

describe("the window rule the guard enforces", () => {
  // Instagram and Messenger both carry a 24h free-form window plus a 7-day
  // human-agent extension. `effectiveSendWindowMs` returns the WIDER band, which
  // is right for an agent reply and wrong for a broadcast — which is exactly why
  // the runner checks `freeFormWindowMs` rather than the effective window.
  for (const channel of ["instagram", "messenger"] as const) {
    it(`${channel}: the broadcast guard uses the 24h window, not the 7-day band`, () => {
      const caps = CHANNEL_CAPABILITIES[channel];
      expect(caps.freeFormWindowMs).toBe(24 * 60 * 60 * 1000);
      expect(caps.humanAgentWindowMs).toBe(7 * 24 * 60 * 60 * 1000);
      // The two are genuinely different, so which one the runner reads decides
      // whether a broadcast can be tagged at all.
      expect(effectiveSendWindowMs(caps)).toBeGreaterThan(caps.freeFormWindowMs!);

      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      // Two days after the last inbound: inside the human-agent band, OUTSIDE the
      // free-form window. That recipient is precisely the one that used to be
      // tagged, and must now be skipped.
      expect(
        computeWindowStatus(twoDaysAgo, Date.now(), caps.freeFormWindowMs!).state,
      ).toBe("closed");
      expect(
        computeWindowStatus(twoDaysAgo, Date.now(), effectiveSendWindowMs(caps)!).state,
      ).not.toBe("closed");
    });
  }

  it("leaves an IN-window recipient perfectly legal to broadcast to", () => {
    // The safe fix must not become "social broadcasts are impossible". Meta's own
    // definition of RESPONSE is explicit that it "includes promotional and
    // non-promotional messages sent inside the 24-hour standard messaging
    // window" — so an in-window freeform broadcast needs no tag and breaks no
    // rule. On Instagram it is the ONLY way to broadcast at all, since there is
    // no approved-template catalogue.
    const caps = CHANNEL_CAPABILITIES.instagram;
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(computeWindowStatus(anHourAgo, Date.now(), caps.freeFormWindowMs!).state).not.toBe(
      "closed",
    );
    expect(caps.templates).toBe(false);
  });
});

describe("Meta's abuse warning stops the campaign, it does not slow it", () => {
  const abuse = (code: number, subcode: number) =>
    normalizeMetaSendError(
      new MetaSendError(
        "graph POST 400",
        400,
        JSON.stringify({ error: { code, error_subcode: subcode } }),
      ),
    );

  it("classifies 613/2018338 as abuse_warning, NOT rate_limited", () => {
    // The two share code 613 and want opposite responses. `rate_limited` engages
    // the retry machinery — and retrying is exactly the "further misuse of API
    // features [that] may result in messaging restrictions being placed on your
    // Page". Getting this wrong pushes straight through Meta's only warning.
    expect(abuse(613, 2018338)?.code).toBe("abuse_warning");
  });

  it("still treats an ordinary 613 as a rate limit", () => {
    // `613 – 2534040` really is "Calls to this api have exceeded the rate
    // limit" — that one SHOULD back off and retry. The new branch must not
    // swallow the whole 613 family.
    expect(abuse(613, 2534040)?.code).toBe("rate_limited");
  });

  it("names the account risk in the message, not a throughput problem", () => {
    const msg = abuse(613, 2018338)?.message ?? "";
    expect(msg).toMatch(/restrict/i);
    // "slow down" would send an operator to tune pacing while the real fix is to
    // stop and look at what is being sent.
    expect(msg).not.toMatch(/try again in a moment/i);
  });

  it("is excluded from EVERY auto-resume path, not just the sweeper", () => {
    // Silently resuming a campaign Meta has called abusive is how a warning
    // becomes a restriction. It needs a person, not a timer. The exclusion
    // used to live only in the cooldown sweeper's branch — boot recovery and
    // the settings-save resume both silently re-fired the campaign. Now the
    // reconciler excludes it UNCONDITIONALLY, the settings-save resume
    // excludes it too, and the ONLY way out is the explicit operator action.
    const runner = readFileSync("src/lib/broadcast-runner.ts", "utf8");
    // Two unconditional exclusions (reconciler + settings-save resume)…
    expect(
      runner.match(/pausedReason: \{ not: "abuse_warning" \}/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
    // …the sweeper still refuses template pauses…
    expect(runner).toContain('pausedReason: { not: "template" }');
    // …and the deliberate human exit exists.
    expect(runner).toContain("resumeBroadcastManually");
    // …and it trips on the FIRST hit rather than accumulating a streak.
    expect(runner).toContain("tripPermanentBreakerNow");
  });
});

describe("an AGENT reply keeps the tag — the approved use", () => {
  it("still tags a human agent's own reply in the 24h-7d band", () => {
    // The send path reads the WIDER window for agent replies, which is what makes
    // a two-day-old support thread answerable at all. Losing that would be the
    // opposite failure: silently dropping legitimate replies.
    const sendText = readFileSync("src/lib/messaging/send-text-internal.ts", "utf8");
    expect(sendText).toContain("outsideFreeFormWindow");
    expect(sendText).toContain("effectiveSendWindowMs");
  });
});
