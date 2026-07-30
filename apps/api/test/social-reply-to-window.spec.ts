/**
 * `reply_to` on a Meta SOCIAL send is bounded by 24h — the Human Agent tag is not.
 *
 * Meta's Send API reference puts a precondition on the `reply_to` field that the
 * messaging window itself does not have:
 *
 *   reply_to.mid — "The message id of the specific message in the chat that your
 *   Page is replying to. […] The page should have received a message from the
 *   user within the last 24 hours."
 *
 * The HUMAN_AGENT tag buys 7 days to SEND. It does not extend `reply_to`. We
 * treated the two as independent and attached the quote whenever the agent had
 * picked a message to reply to, so a quoted reply on a two-day-old thread — the
 * exact case the 24h–7d support band exists for — put a field Meta documents as
 * 24h-only into a send Meta accepts for 7 days, risking rejection of the WHOLE
 * message rather than delivery without the quote.
 *
 * Losing the quote is cosmetic. Losing the reply is the agent's answer never
 * reaching the customer, which is why the fragment now drops rather than gambles.
 *
 * This pins the pairing at the wire level for all three social send shapes
 * (text / media / interactive), because the fragment is shared and a future edit
 * to any one call site would otherwise go unnoticed.
 *
 *   pnpm --filter @ccp/api exec vitest run test/social-reply-to-window.spec.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendSocialText } from "@/lib/providers/meta-social";

const target = {
  accountId: "PAGE_1",
  accessToken: "tok",
  graphVersion: "v23.0",
  label: "messenger",
};

/** Capture the JSON body of the single Graph POST a send makes. */
function captureBody(): () => Record<string, unknown> {
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ message_id: "mid.1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return () => body;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inside the 24h window", () => {
  it("sends the quote, with messaging_type RESPONSE and no tag", async () => {
    const body = captureBody();
    await sendSocialText(
      { to: "PSID", body: "hi", replyToExternalId: "mid.orig", useHumanAgentTag: false },
      target,
    );

    expect(body()).toMatchObject({
      messaging_type: "RESPONSE",
      reply_to: { mid: "mid.orig" },
    });
    expect(body()).not.toHaveProperty("tag");
  });
});

describe("outside the 24h window (the 24h–7d Human Agent band)", () => {
  it("still SENDS, tagged HUMAN_AGENT — the reply must not be lost", async () => {
    const body = captureBody();
    await sendSocialText(
      { to: "PSID", body: "hi", replyToExternalId: "mid.orig", useHumanAgentTag: true },
      target,
    );

    expect(body()).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
  });

  it("drops reply_to — Meta documents it as 24h-only", async () => {
    const body = captureBody();
    await sendSocialText(
      { to: "PSID", body: "hi", replyToExternalId: "mid.orig", useHumanAgentTag: true },
      target,
    );

    expect(body()).not.toHaveProperty("reply_to");
  });
});

describe("an unknown window resolves conservatively", () => {
  it("keeps the tag and drops the quote when the band was not passed", async () => {
    // Both halves assume possibly-outside. Keeping the tag is valid across the
    // whole 7 days; keeping the quote would not be.
    const body = captureBody();
    await sendSocialText(
      { to: "PSID", body: "hi", replyToExternalId: "mid.orig" },
      target,
    );

    expect(body()).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
    expect(body()).not.toHaveProperty("reply_to");
  });
});

describe("a send that is not a reply", () => {
  it("carries no reply_to in either band", async () => {
    for (const useHumanAgentTag of [true, false]) {
      const body = captureBody();
      await sendSocialText({ to: "PSID", body: "hi", useHumanAgentTag }, target);
      expect(body(), `band=${useHumanAgentTag}`).not.toHaveProperty("reply_to");
      vi.unstubAllGlobals();
    }
  });
});
