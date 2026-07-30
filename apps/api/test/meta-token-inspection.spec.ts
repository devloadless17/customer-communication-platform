import { describe, expect, it } from "vitest";

import { evaluateDebugTokenData } from "@/workspace-settings/meta/meta.service";

/**
 * debug_token inspection at credential save (Meta Access Tokens / Permissions
 * docs). The rules under test:
 *
 *  - `is_valid: false` is the ONE blocking outcome — that token is dead for
 *    every channel.
 *  - Scope gaps are WARNINGS, never blocks: the credential is shared by
 *    WhatsApp / Messenger / Instagram, and a Messenger-only workspace
 *    legitimately pastes a token with no `whatsapp_*` scopes.
 *  - A USER-type or expiring token warns (works today, dies quietly later).
 *  - A fully-scoped never-expiring SYSTEM_USER token passes clean.
 */

// Every scope the three channels need, per Meta's own docs:
//   WhatsApp   — Permissions: whatsapp_business_messaging + whatsapp_business_management
//   Messenger  — Webhooks for Pages: pages_messaging + pages_manage_metadata
//   Instagram  — Webhooks for Instagram Messaging: instagram_basic +
//                instagram_manage_messages + pages_manage_metadata
const FULL_SCOPES = [
  "whatsapp_business_messaging",
  "whatsapp_business_management",
  "business_management",
  "pages_messaging",
  "pages_manage_metadata",
  "instagram_basic",
  "instagram_manage_messages",
];

describe("evaluateDebugTokenData", () => {
  it("passes a fully-scoped, never-expiring system-user token with no warnings", () => {
    const out = evaluateDebugTokenData({
      is_valid: true,
      type: "SYSTEM_USER",
      expires_at: 0,
      scopes: FULL_SCOPES,
    });
    expect(out.invalidDetail).toBeNull();
    expect(out.warnings).toEqual([]);
  });

  it("blocks ONLY on is_valid=false — dead for every channel", () => {
    const out = evaluateDebugTokenData({ is_valid: false, scopes: FULL_SCOPES });
    expect(out.invalidDetail).toMatch(/expired or revoked/);
    expect(out.warnings).toEqual([]);
  });

  it("warns — never blocks — on missing whatsapp scopes (shared-credential rule)", () => {
    // A Messenger-only workspace's token: valid, but no whatsapp_* scopes.
    const out = evaluateDebugTokenData({
      is_valid: true,
      type: "SYSTEM_USER",
      expires_at: 0,
      scopes: ["business_management", "pages_messaging", "pages_manage_metadata"],
    });
    expect(out.invalidDetail).toBeNull();
    // Asserted by CONTENT, not by count: all three channels are now checked, so a
    // token scoped only for Messenger legitimately draws both a WhatsApp and an
    // Instagram note. Pinning a count here would just break whenever a channel is
    // added, without saying anything about the rule under test.
    expect(out.warnings.join(" ")).toMatch(
      /whatsapp_business_messaging \+ whatsapp_business_management/,
    );
  });

  it("warns on missing business_management (portfolio can't resolve)", () => {
    const out = evaluateDebugTokenData({
      is_valid: true,
      type: "SYSTEM_USER",
      expires_at: 0,
      scopes: ["whatsapp_business_messaging", "whatsapp_business_management"],
    });
    expect(out.invalidDetail).toBeNull();
    const portfolioWarning = out.warnings.find((w) => /portfolio/i.test(w));
    expect(portfolioWarning).toMatch(/business_management/);
  });

  it("warns on a USER token and on a real expiry", () => {
    const out = evaluateDebugTokenData({
      is_valid: true,
      type: "USER",
      expires_at: 1_712_099_387,
      scopes: FULL_SCOPES,
    });
    expect(out.invalidDetail).toBeNull();
    expect(out.warnings).toHaveLength(2);
    expect(out.warnings[0]).toMatch(/User token/);
    expect(out.warnings[1]).toMatch(/2024-04-02/); // epoch 1712099387 → 2024-04-02
  });

  it("warns about MESSENGER scopes — the shared token serves all three channels", () => {
    // The gap this closes: only the whatsapp_* scopes were checked, so a workspace
    // pasting a token with no `pages_messaging` got a clean bill of health and then
    // hit an opaque Meta failure when it tried to connect a Page. Catching it at
    // paste time with a named fix is the whole point of this inspection.
    const out = evaluateDebugTokenData({
      is_valid: true,
      type: "SYSTEM_USER",
      expires_at: 0,
      scopes: FULL_SCOPES.filter((s) => s !== "pages_messaging"),
    });
    expect(out.invalidDetail).toBeNull();
    expect(out.warnings.join(" ")).toMatch(/pages_messaging/);
    expect(out.warnings.join(" ")).toMatch(/Messenger/);
  });

  it("warns about INSTAGRAM scopes, including the shared pages_manage_metadata", () => {
    // Instagram here is Instagram-via-Facebook-Login, so it subscribes through the
    // LINKED PAGE — which is why it needs pages_manage_metadata just like Messenger.
    const out = evaluateDebugTokenData({
      is_valid: true,
      type: "SYSTEM_USER",
      expires_at: 0,
      scopes: FULL_SCOPES.filter(
        (s) => s !== "instagram_manage_messages" && s !== "pages_manage_metadata",
      ),
    });
    const text = out.warnings.join(" ");
    expect(text).toMatch(/instagram_manage_messages/);
    expect(text).toMatch(/pages_manage_metadata/);
    // Messenger ALSO needs pages_manage_metadata, so both channels are named.
    expect(text).toMatch(/Messenger/);
    expect(text).toMatch(/Instagram/);
  });

  it("phrases a gap as LIVE BREAKAGE only for a channel that is actually connected", () => {
    const scopes = FULL_SCOPES.filter((s) => s !== "pages_messaging");
    const notConnected = evaluateDebugTokenData(
      { is_valid: true, type: "SYSTEM_USER", expires_at: 0, scopes },
      new Set(),
    );
    const connected = evaluateDebugTokenData(
      { is_valid: true, type: "SYSTEM_USER", expires_at: 0, scopes },
      new Set(["messenger" as const]),
    );
    // Not connected → "you can't connect it". Connected → "it is broken NOW".
    expect(notConnected.warnings.join(" ")).toMatch(/can't be connected/);
    expect(connected.warnings.join(" ")).toMatch(/is connected, so/);
  });

  it("warns on data-access expiry separately from token expiry", () => {
    // Distinct failure: data access can lapse while the token stays valid, and the
    // symptom is a permissions error rather than an auth error — which sends people
    // hunting in the wrong place.
    const out = evaluateDebugTokenData({
      is_valid: true,
      type: "SYSTEM_USER",
      expires_at: 0,
      data_access_expires_at: 1_800_000_000,
      scopes: FULL_SCOPES,
    });
    expect(out.warnings.join(" ")).toMatch(/DATA ACCESS expires/);
  });

  it("stays quiet on an indeterminate shape (no scopes array, unknown fields)", () => {
    // Meta changed the payload / scopes absent → no definitive answer, so no
    // scope warnings may be invented from silence.
    const out = evaluateDebugTokenData({ is_valid: true });
    expect(out.invalidDetail).toBeNull();
    expect(out.warnings).toEqual([]);
    // Non-string junk inside scopes is ignored, not crashed on.
    const junk = evaluateDebugTokenData({
      is_valid: true,
      scopes: [42, null, ...FULL_SCOPES],
      expires_at: "soon",
      type: 7,
    });
    expect(junk.invalidDetail).toBeNull();
    expect(junk.warnings).toEqual([]);
  });
});
