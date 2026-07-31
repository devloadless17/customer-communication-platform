/**
 * `business_username_updates` status semantics (BSUID/usernames reference,
 * verified 2026-07-31). The documented value is
 * `{display_phone_number, username, status}`, status ∈ approved | reserved |
 * deleted — and on `deleted` the username field is OMITTED. The status is
 * load-bearing: before this was parsed, a `deleted` webhook (username removed
 * in the Business app, or force-transferred onto a sibling number) stored the
 * just-revoked handle as the number's CURRENT @username — the event that
 * exists to keep the cache honest corrupted it instead.
 *
 * Also pins the `username_suggestions` response unwrap: the documented shape
 * nests the suggestions array inside a data row
 * (`{data:[{username_suggestions:[...]}]}`), which the tolerant row extractor
 * previously could not read — suggestions silently never surfaced.
 *
 *   pnpm --filter @ccp/api exec vitest run test/username-webhook-status.spec.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { metaProvider } from "@/lib/providers/meta";
import type { MetaSendConfig } from "@/lib/providers/config";

function usernameEnvelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_USERNAME_TEST",
        time: 1785400000,
        changes: [{ field: "business_username_updates", value }],
      },
    ],
  };
}

function healthEvents(payload: unknown) {
  return metaProvider
    .parseWebhook(payload)
    .filter((e) => e.kind === "channel_health");
}

describe("business_username_updates · status drives store vs clear vs drop", () => {
  it("approved stores the handle, lowercased", () => {
    const events = healthEvents(
      usernameEnvelope({
        display_phone_number: "+961 70 000 001",
        username: "AcmeSupport",
        status: "approved",
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      businessUsername: "acmesupport",
      wabaId: "WABA_USERNAME_TEST",
      displayPhoneNumber: "+961 70 000 001",
    });
  });

  it("reserved stores the handle too — it is the number's adopted handle, pre-GA", () => {
    const events = healthEvents(
      usernameEnvelope({
        display_phone_number: "+961 70 000 001",
        username: "acmesupport",
        status: "reserved",
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ businessUsername: "acmesupport" });
  });

  it("a missing status is tolerated as an adopt (earlier payload generations)", () => {
    const events = healthEvents(
      usernameEnvelope({
        display_phone_number: "+961 70 000 001",
        username: "acmesupport",
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ businessUsername: "acmesupport" });
  });

  it("deleted CLEARS the stored handle — username is omitted on this status", () => {
    const events = healthEvents(
      usernameEnvelope({
        display_phone_number: "+961 70 000 001",
        status: "deleted",
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ businessUsername: null });
  });

  it("deleted WITH a username still clears — storing it would re-assert the revoked handle", () => {
    const events = healthEvents(
      usernameEnvelope({
        display_phone_number: "+961 70 000 001",
        username: "acmesupport",
        status: "deleted",
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ businessUsername: null });
  });

  it("an unknown status stores nothing — never a guess", () => {
    const events = healthEvents(
      usernameEnvelope({
        display_phone_number: "+961 70 000 001",
        username: "acmesupport",
        status: "pending_review",
      }),
    );
    expect(events).toHaveLength(0);
  });
});

describe("username_suggestions · documented nesting unwraps", () => {
  const CONFIG = {
    phoneNumberId: "pn_username_test",
    accessToken: "tok",
    graphVersion: "v26.0",
  } as MetaSendConfig;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubJson(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  }

  it("reads the documented {data:[{username_suggestions:[...]}]} shape", async () => {
    stubJson({
      data: [{ username_suggestions: ["AcmeHelp", "acme.support", "acmehelp"] }],
    });
    await expect(metaProvider.getUsernameSuggestions!(CONFIG)).resolves.toEqual([
      "acmehelp",
      "acme.support",
    ]);
  });

  it("keeps the older tolerances — bare strings and {username} rows", async () => {
    stubJson({ data: ["AcmeHelp", { username: "acme.support" }] });
    await expect(metaProvider.getUsernameSuggestions!(CONFIG)).resolves.toEqual([
      "acmehelp",
      "acme.support",
    ]);
  });
});
