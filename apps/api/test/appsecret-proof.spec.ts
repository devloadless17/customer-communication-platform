/**
 * `appsecret_proof` on WhatsApp Graph calls.
 *
 * Meta: "an access token can be stolen by malicious software on a person's
 * computer or a man in the middle attack. Then that access token can be used from
 * an entirely different system." The proof — `HMAC-SHA256(access_token, key =
 * app_secret)` — binds a call to knowledge of the app secret, so a leaked token is
 * useless on its own.
 *
 * WHY THIS SPEC EXISTS. The helper had been in the tree for a while and was
 * reported as "implemented, just needs a live send to verify". It was not: only the
 * `graph*` helpers (Messenger/Instagram, subscriptions, health) signed their calls,
 * while all 51 WhatsApp call sites went through `metaFetch`, which signed nothing
 * and had no app secret available to sign with. Enabling Meta's "Require App
 * Secret" toggle would have kept social working and failed EVERY WhatsApp send.
 *
 * That gap was invisible because the feature is off by default: with the flag
 * unset, signed and unsigned code are byte-identical on the wire. So the coverage
 * has to be asserted with the flag ON, which is what this file does.
 *
 * The env flag is read at module load, so each case imports the modules FRESH
 * inside the test after setting it — a top-level import would capture whatever the
 * suite's env happened to be.
 *
 *   pnpm --filter @ccp/api exec vitest run test/appsecret-proof.spec.ts
 */
import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What Meta documents: sha256 HMAC of the token, keyed by the app secret, hex. */
function expectedProof(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

/** Load `meta.ts` with the flag in a known state. */
async function loadProvider(enabled: boolean) {
  vi.resetModules();
  if (enabled) process.env.META_APPSECRET_PROOF = "1";
  else delete process.env.META_APPSECRET_PROOF;
  return (await import("@/lib/providers/meta")).metaProvider;
}

/** Capture the URL of the single Graph call a send makes. */
function captureUrl(): () => string {
  let url = "";
  vi.stubGlobal("fetch", async (input: string | URL) => {
    url = String(input);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.TEST" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return () => url;
}

const TOKEN = "EAAG_test_token";
const OWN_SECRET = "this_accounts_own_app_secret";

const config = {
  phoneNumberId: "PHONE_1",
  accessToken: TOKEN,
  graphVersion: "v26.0",
  appSecret: OWN_SECRET,
};

const originalFlag = process.env.META_APPSECRET_PROOF;

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  if (originalFlag === undefined) delete process.env.META_APPSECRET_PROOF;
  else process.env.META_APPSECRET_PROOF = originalFlag;
});

describe("disabled (the default, and how it ships)", () => {
  it("sends NO proof — the wire is byte-identical to before", async () => {
    const provider = await loadProvider(false);
    const url = captureUrl();

    await provider.sendText({ to: "16505551234", body: "hi" }, config);

    expect(url()).not.toContain("appsecret_proof");
  });
});

describe("enabled", () => {
  it("signs a WhatsApp SEND — the path that was previously unsigned", async () => {
    const provider = await loadProvider(true);
    const url = captureUrl();

    await provider.sendText({ to: "16505551234", body: "hi" }, config);

    expect(url()).toContain(`appsecret_proof=${expectedProof(TOKEN, OWN_SECRET)}`);
  });

  it("uses THIS ACCOUNT'S own secret, not some other app's", async () => {
    // The load-bearing detail: the secret must belong to the app that ISSUED the
    // token. An account onboarded under a different Meta app has its own, and
    // signing with the workspace's shared secret would make every proof invalid
    // for exactly those accounts — while looking fine for everyone else.
    const provider = await loadProvider(true);
    const url = captureUrl();

    await provider.sendText(
      { to: "16505551234", body: "hi" },
      { ...config, appSecret: "a_DIFFERENT_apps_secret" },
    );

    expect(url()).toContain(`appsecret_proof=${expectedProof(TOKEN, "a_DIFFERENT_apps_secret")}`);
    expect(url()).not.toContain(expectedProof(TOKEN, OWN_SECRET));
  });

  it("degrades to no proof when the account has no stored secret", async () => {
    // Additive by design: Meta accepts an unsigned call unless "Require App
    // Secret" is on, so a missing/undecryptable secret must never block a send.
    const provider = await loadProvider(true);
    const url = captureUrl();

    await provider.sendText({ to: "16505551234", body: "hi" }, { ...config, appSecret: undefined });

    expect(url()).not.toContain("appsecret_proof");
  });

  it("appends with & when the URL already has a query string", async () => {
    // A naive `?` join would produce a second question mark and Meta would read
    // the proof as part of the previous parameter's value.
    const provider = await loadProvider(true);
    const { withAppsecretProof } = await import("@/lib/providers/appsecret-proof");

    const signed = withAppsecretProof("https://graph.facebook.com/v26.0/x?fields=a", TOKEN, OWN_SECRET);

    expect(signed).toContain("?fields=a&appsecret_proof=");
    expect(signed.match(/\?/g)).toHaveLength(1);
  });
});

describe("the formula itself", () => {
  it("matches Meta's documented hash exactly", async () => {
    // hash_hmac('sha256', $access_token, $app_secret) — token as the MESSAGE,
    // secret as the KEY. Swapping them yields a plausible-looking hex string that
    // Meta rejects, so pin the direction.
    const { appsecretProof } = await import("@/lib/providers/appsecret-proof");

    expect(appsecretProof(TOKEN, OWN_SECRET)).toBe(expectedProof(TOKEN, OWN_SECRET));
    expect(appsecretProof(TOKEN, OWN_SECRET)).not.toBe(expectedProof(OWN_SECRET, TOKEN));
  });
});
