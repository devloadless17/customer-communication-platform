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

const FULL_SCOPES = [
  "whatsapp_business_messaging",
  "whatsapp_business_management",
  "business_management",
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
      scopes: ["business_management", "pages_messaging"],
    });
    expect(out.invalidDetail).toBeNull();
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(
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
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/business_management/);
    expect(out.warnings[0]).toMatch(/portfolio/i);
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
