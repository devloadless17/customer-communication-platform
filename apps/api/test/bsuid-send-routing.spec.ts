/**
 * BSUID send addressing — the wire form, the legacy fallback, and the
 * cross-portfolio guard.
 *
 * Per the BSUID page + Send Marketing Messages reference (2026-07): a BSUID
 * rides the TOP-LEVEL `recipient` field on `/messages`, and `to` must be
 * omitted ("recipient — … used only when `to` is omitted; if both are provided,
 * `to` wins"). Every one of the provider's 12 send sites addresses through one
 * helper (`whatsappDestination`), and `postWhatsappMessages` keeps the
 * pre-July server behaviour working with a ONE-SHOT retry: when Meta rejects
 * the `recipient` FIELD itself (#100 naming the param, or the documented
 * misleading "The parameter to is required"), the same body is re-posted with
 * the BSUID in `to`. Any other failure — including every failure of a
 * phone-addressed send — passes through untouched.
 *
 * `applyBsuidPortfolioGuard` is the send-side portfolio check: a BSUID is
 * scoped to ONE business portfolio, so a template send from a sibling
 * portfolio's number is Meta-guaranteed to fail. Known mismatch → retarget to
 * the stored parent BSUID (the cross-portfolio key) or refuse locally; any
 * UNKNOWN side passes through (Meta stays the authority).
 *
 *   pnpm --filter @ccp/api exec vitest run test/bsuid-send-routing.spec.ts
 */
import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";
import { metaProvider } from "@/lib/providers/meta";
import type { MetaSendConfig } from "@/lib/providers/config";
import type { ResolvedChannel } from "@/lib/providers/channel";
import {
  applyBsuidPortfolioGuard,
  BsuidPortfolioMismatchError,
} from "@/lib/messaging/bsuid-routing";

const CONFIG = {
  phoneNumberId: "pn_bsuid_wire",
  accessToken: "tok",
  graphVersion: "v26.0",
} as MetaSendConfig;

const BSUID = "LB.946402411360800";
const PHONE = "96170000001";

/** Stub fetch to capture every POSTed /messages body, replying per `responses`
 *  (last one repeats). Default: a plain 200 with a message id. */
function stubFetch(
  responses: Array<{ status: number; body: unknown }> = [
    { status: 200, body: { messages: [{ id: "wamid.WIRE_OK" }] } },
  ],
) {
  const bodies: Array<Record<string, unknown>> = [];
  const fn = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    const r = responses[Math.min(bodies.length - 1, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { bodies, fn };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setSharedDb(undefined as unknown as PrismaClient);
});

// Every send site that addresses a customer message. Each returns the promise
// so failure surfaces in the test, and each is exercised in BOTH address forms.
const SEND_SITES: Array<{
  name: string;
  run: (to: string, viaBsuid: boolean) => Promise<unknown>;
}> = [
  {
    name: "sendText",
    run: (to, viaBsuid) => metaProvider.sendText({ to, viaBsuid, body: "hi" }, CONFIG),
  },
  {
    name: "sendMedia",
    run: (to, viaBsuid) =>
      metaProvider.sendMedia!({ to, viaBsuid, kind: "image", mediaId: "media_1" }, CONFIG),
  },
  {
    name: "sendTemplate",
    run: (to, viaBsuid) =>
      metaProvider.sendTemplate!(
        { to, viaBsuid, name: "order_update", language: "en_US", variables: { body: [] } },
        CONFIG,
      ),
  },
  {
    name: "sendInteractive(buttons)",
    run: (to, viaBsuid) =>
      metaProvider.sendInteractive!(
        {
          to,
          viaBsuid,
          bodyText: "Pick one",
          kind: "buttons",
          options: [{ id: "a", title: "A" }],
        },
        CONFIG,
      ),
  },
  {
    name: "sendInteractive(request_contact_info)",
    run: (to, viaBsuid) =>
      metaProvider.sendInteractive!(
        {
          to,
          viaBsuid,
          bodyText: "Mind sharing your number?",
          kind: "request_contact_info",
          options: [],
        },
        CONFIG,
      ),
  },
  {
    name: "sendReaction",
    run: (to, viaBsuid) =>
      metaProvider.sendReaction!(
        { to, viaBsuid, messageExternalId: "wamid.TARGET", emoji: "👍" },
        CONFIG,
      ),
  },
  {
    name: "sendLocation",
    run: (to, viaBsuid) =>
      metaProvider.sendLocation!({ to, viaBsuid, latitude: 33.89, longitude: 35.5 }, CONFIG),
  },
  {
    name: "sendContacts",
    run: (to, viaBsuid) =>
      metaProvider.sendContacts!(
        { to, viaBsuid, contacts: [{ name: "Ada Lovelace", phones: ["96171000000"] }] },
        CONFIG,
      ),
  },
];

describe("whatsappDestination across every send site", () => {
  for (const site of SEND_SITES) {
    it(`${site.name}: viaBsuid rides top-level \`recipient\` with NO \`to\``, async () => {
      const { bodies } = stubFetch();
      await site.run(BSUID, true);
      expect(bodies).toHaveLength(1);
      const body = bodies[0]!;
      expect(body.recipient).toBe(BSUID);
      // `to` must be OMITTED, not just empty — Meta uses `to` and silently
      // ignores `recipient` whenever both are present.
      expect(body).not.toHaveProperty("to");
      expect(body.messaging_product).toBe("whatsapp");
    });

    it(`${site.name}: a phone send keeps the classic \`to\` form, with NO \`recipient\``, async () => {
      const { bodies } = stubFetch();
      await site.run(PHONE, false);
      expect(bodies).toHaveLength(1);
      const body = bodies[0]!;
      expect(body.to).toBe(PHONE);
      expect(body).not.toHaveProperty("recipient");
    });
  }

  it("request_contact_info posts the fixed interactive wire shape", async () => {
    // The BSUID rollout's proactive remedy: the reply carries the customer's
    // own phone (origin: "contact_request"), so the exact wire matters.
    const { bodies } = stubFetch();
    await metaProvider.sendInteractive!(
      {
        to: BSUID,
        viaBsuid: true,
        bodyText: "Mind sharing your number?",
        kind: "request_contact_info",
        options: [],
      },
      CONFIG,
    );
    expect(bodies[0]).toMatchObject({
      type: "interactive",
      interactive: {
        type: "request_contact_info",
        body: { text: "Mind sharing your number?" },
        action: { name: "request_contact_info" },
      },
    });
  });
});

describe("legacy-`to` fallback (postWhatsappMessages)", () => {
  const rejected = {
    status: 400,
    body: {
      error: {
        message: '(#100) Unexpected parameter "recipient"',
        type: "OAuthException",
        code: 100,
      },
    },
  };
  const ok = { status: 200, body: { messages: [{ id: "wamid.FALLBACK_OK" }] } };

  it("retries ONCE with the BSUID in `to` when Meta rejects the `recipient` param", async () => {
    const { bodies, fn } = stubFetch([rejected, ok]);
    const res = await metaProvider.sendText({ to: BSUID, viaBsuid: true, body: "hi" }, CONFIG);
    expect(fn).toHaveBeenCalledTimes(2);
    // First attempt: the new form.
    expect(bodies[0]!.recipient).toBe(BSUID);
    expect(bodies[0]).not.toHaveProperty("to");
    // Retry: the pre-July form — the SAME body with the BSUID moved into `to`.
    expect(bodies[1]!.to).toBe(BSUID);
    expect(bodies[1]).not.toHaveProperty("recipient");
    expect(bodies[1]!.text).toEqual(bodies[0]!.text);
    expect(res.externalId).toBe("wamid.FALLBACK_OK");
  });

  it("retries on the documented misleading 'parameter to is required' #100 text", async () => {
    // When the server predates `recipient` it IGNORES the field and then
    // complains that `to` is missing — that shape means the same thing.
    const { bodies, fn } = stubFetch([
      {
        status: 400,
        body: {
          error: { message: "(#100) The parameter to is required.", type: "OAuthException", code: 100 },
        },
      },
      ok,
    ]);
    const res = await metaProvider.sendText({ to: BSUID, viaBsuid: true, body: "hi" }, CONFIG);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(bodies[1]!.to).toBe(BSUID);
    expect(res.externalId).toBe("wamid.FALLBACK_OK");
  });

  it("does NOT retry a 400 with a different error code", async () => {
    // 131026 (recipient can't receive) also mentions "recipient" in prose —
    // the code gate is what keeps this from double-posting a billed send.
    const { fn } = stubFetch([
      {
        status: 400,
        body: {
          error: { message: "Receiver is incapable of receiving this message", type: "OAuthException", code: 131026 },
        },
      },
    ]);
    await expect(
      metaProvider.sendText({ to: BSUID, viaBsuid: true, body: "hi" }, CONFIG),
    ).rejects.toThrow(/131026|failed/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a phone-addressed 400, whatever the code says", async () => {
    // No `recipient` in the body → the fallback has nothing to translate;
    // the caller's own error handling must see the failure untouched.
    const { fn } = stubFetch([rejected]);
    await expect(
      metaProvider.sendText({ to: PHONE, body: "hi" }, CONFIG),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("applyBsuidPortfolioGuard", () => {
  /** Install a fake db resolving WABA id → portfolioId. The guard caches per
   *  WABA id process-wide, so every case uses a UNIQUE waba id. */
  function installWabaPortfolios(map: Record<string, string | null>) {
    const findUnique = vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id in map ? { portfolioId: map[where.id] } : null,
    );
    setSharedDb({
      whatsappBusinessAccount: { findUnique },
    } as unknown as PrismaClient);
    return findUnique;
  }

  const channel: ResolvedChannel = { channel: "whatsapp", to: BSUID, viaBsuid: true };

  it("is a no-op for a phone-addressed send (and never touches the db)", async () => {
    const findUnique = installWabaPortfolios({});
    const phoneChannel: ResolvedChannel = { channel: "whatsapp", to: PHONE };
    await expect(
      applyBsuidPortfolioGuard(phoneChannel, { bsuidPortfolioId: "pf_a", parentBsuid: null }, { wabaAccountId: "waba_g1" }),
    ).resolves.toBe(phoneChannel);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("passes through when the CONTACT side is unknown", async () => {
    const findUnique = installWabaPortfolios({});
    await expect(
      applyBsuidPortfolioGuard(channel, { bsuidPortfolioId: null, parentBsuid: null }, { wabaAccountId: "waba_g2" }),
    ).resolves.toBe(channel);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("passes through when the SENDING side names no WABA", async () => {
    installWabaPortfolios({});
    await expect(
      applyBsuidPortfolioGuard(channel, { bsuidPortfolioId: "pf_a", parentBsuid: null }, {}),
    ).resolves.toBe(channel);
  });

  it("passes through when the sending WABA's portfolio is unknown", async () => {
    installWabaPortfolios({ waba_g3: null });
    await expect(
      applyBsuidPortfolioGuard(channel, { bsuidPortfolioId: "pf_a", parentBsuid: null }, { wabaAccountId: "waba_g3" }),
    ).resolves.toBe(channel);
  });

  it("passes through when both portfolios MATCH", async () => {
    installWabaPortfolios({ waba_g4: "pf_a" });
    await expect(
      applyBsuidPortfolioGuard(channel, { bsuidPortfolioId: "pf_a", parentBsuid: null }, { wabaAccountId: "waba_g4" }),
    ).resolves.toBe(channel);
  });

  it("retargets a proven mismatch to the stored parent BSUID", async () => {
    installWabaPortfolios({ waba_g5: "pf_b" });
    const out = await applyBsuidPortfolioGuard(
      channel,
      { bsuidPortfolioId: "pf_a", parentBsuid: "US.ENT.777" },
      { wabaAccountId: "waba_g5" },
    );
    expect(out.to).toBe("US.ENT.777");
    // Still a BSUID-addressed send — the parent id rides `recipient` too.
    expect(out.viaBsuid).toBe(true);
  });

  it("refuses locally on a proven mismatch with no parent to fall back on", async () => {
    installWabaPortfolios({ waba_g6: "pf_b" });
    await expect(
      applyBsuidPortfolioGuard(channel, { bsuidPortfolioId: "pf_a", parentBsuid: null }, { wabaAccountId: "waba_g6" }),
    ).rejects.toBeInstanceOf(BsuidPortfolioMismatchError);
  });
});
