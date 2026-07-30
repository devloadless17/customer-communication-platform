/**
 * `account_update` — the integration going DARK, and coming back.
 *
 * Meta names and documents these events; an earlier comment in the parser claimed it
 * "publishes no name or shape" for the app-removed case, which is why all of them
 * fell through to an anonymous 500-char alert blob with no effect on sending.
 *
 * Two classes, deliberately handled differently:
 *
 *   PERMANENT — PARTNER_REMOVED (the WABA was unshared), PARTNER_APP_UNINSTALLED
 *   (the customer deauthenticated/uninstalled), ACCOUNT_DELETED. Nothing we do
 *   resumes these; the customer must re-onboard.
 *
 *   TRANSIENT — ACCOUNT_OFFBOARDED, a Coexistence device change or number
 *   re-registration. Meta is explicit: "Cloud API messaging | Suspended — messages
 *   cannot be sent or received via Cloud API while reonboarding is in progress" and
 *   "Pause any pending Cloud API message sends for this client, as they fail while
 *   reonboarding is in progress." Reonboarding finishes in minutes and
 *   ACCOUNT_RECONNECTED announces it — webhooks keep flowing throughout, so the
 *   recovery signal does arrive. Unmodelled, an in-flight broadcast kept firing into
 *   guaranteed failure, burning recipient rows and the rolling-24h budget.
 *
 * Both reuse the messaging restriction PAIR, exactly as DISABLED_UPDATE does, so the
 * composer, banner and broadcast-pause surfaces stay on one code path.
 *
 *   pnpm --filter @ccp/api exec vitest run test/account-update-disconnect.spec.ts
 */
import { describe, expect, it } from "vitest";

import { metaProvider } from "@/lib/providers/meta";

function accountUpdate(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA_1", changes: [{ field: "account_update", value }] }],
  };
}

/** The single channel_health event, or undefined. */
function health(payload: unknown) {
  return metaProvider.parseWebhook(payload).find((e) => e.kind === "channel_health") as
    | {
        kind: "channel_health";
        bizMessagingRestrictionType?: string | null;
        customerMessagingRestrictionType?: string | null;
        bizMessagingRestrictedUntil?: Date | null;
        accountAlert?: { event: string | null; detail: string } | null;
      }
    | undefined;
}

describe("permanent disconnects block sending in BOTH directions", () => {
  for (const event of ["PARTNER_REMOVED", "PARTNER_APP_UNINSTALLED", "ACCOUNT_DELETED"]) {
    it(`${event} sets the restriction pair with no expiry`, () => {
      const h = health(accountUpdate({ event }));
      expect(h, `${event} must not fall through to the anonymous alert`).toBeDefined();
      expect(h!.bizMessagingRestrictionType).toBe(event);
      expect(h!.customerMessagingRestrictionType).toBe(event);
      // No expiry: nothing lapses. Only re-onboarding clears it.
      expect(h!.bizMessagingRestrictedUntil).toBeNull();
    });
  }

  it("carries disconnection_info.reason so churn is distinguishable from a restart", () => {
    const h = health(
      accountUpdate({
        event: "PARTNER_REMOVED",
        disconnection_info: { reason: "PRIMARY_INACTIVITY", initiated_by: "SYSTEM" },
      }),
    );
    // Verbatim, not mapped — a reason Meta adds later must still reach the operator.
    expect(h!.accountAlert?.event).toBe("PARTNER_REMOVED:PRIMARY_INACTIVITY");
    expect(h!.accountAlert?.detail).toContain("PRIMARY_INACTIVITY");
  });
});

describe("Coexistence reonboarding suspends, then resumes", () => {
  it("ACCOUNT_OFFBOARDED suspends sending under its own named type", () => {
    const h = health(accountUpdate({ event: "ACCOUNT_OFFBOARDED" }));
    expect(h).toBeDefined();
    // A distinct type, not reused from a ban: this one is expected to clear on its
    // own within minutes, and the operator message differs.
    expect(h!.bizMessagingRestrictionType).toBe("COEXISTENCE_REONBOARDING");
    expect(h!.customerMessagingRestrictionType).toBe("COEXISTENCE_REONBOARDING");
    expect(h!.accountAlert?.event).toBe("ACCOUNT_OFFBOARDED");
  });

  it("ACCOUNT_RECONNECTED clears the suspension in both directions", () => {
    const h = health(accountUpdate({ event: "ACCOUNT_RECONNECTED" }));
    expect(h).toBeDefined();
    expect(h!.bizMessagingRestrictionType).toBeNull();
    expect(h!.customerMessagingRestrictionType).toBeNull();
    expect(h!.accountAlert?.event).toBe("ACCOUNT_RECONNECTED");
  });

  it("is case-insensitive on the event name", () => {
    const h = health(accountUpdate({ event: "account_offboarded" }));
    expect(h!.bizMessagingRestrictionType).toBe("COEXISTENCE_REONBOARDING");
  });
});

describe("unrelated account_update events are untouched", () => {
  it("an unknown event still lands in the alert slot rather than restricting sends", () => {
    const h = health(accountUpdate({ event: "SOMETHING_META_ADDED_LATER" }));
    expect(h).toBeDefined();
    // Must NOT invent a restriction from an event we don't understand — that would
    // stop a working account from sending.
    expect(h!.bizMessagingRestrictionType).toBeUndefined();
    expect(h!.accountAlert?.event).toBe("SOMETHING_META_ADDED_LATER");
  });
});
