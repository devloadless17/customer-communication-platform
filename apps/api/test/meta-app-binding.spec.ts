/**
 * Which Meta app is each account on?
 *
 * Meta's model is one app ↔ many accounts, so this product keeps ONE shared app
 * per workspace whose credentials are copied onto each account as it connects —
 * while an account may instead carry a different app's credentials.
 *
 * That distinction was already load-bearing and completely invisible. A shared
 * secret rotation must reach the accounts on the shared app and must NOT touch the
 * ones on their own, because overwriting those leaves Meta signing their webhooks
 * with a secret we no longer hold — every inbound for that account then drops as
 * forged. `resyncChannels` made that call with an inline comparison and reported it
 * only in a return value nobody surfaced, so an admin could see how many accounts
 * they had but not which app any of them ran on.
 *
 * The comparison now lives in `classifyMetaAppBinding` and BOTH callers use it: the
 * rotation (deciding what it touches) and the settings UI (telling the admin who is
 * on what). Same function, so the answer an admin reads cannot disagree with the
 * answer the rotation acts on — which is the actual invariant worth pinning.
 *
 *   pnpm --filter @ccp/api exec vitest run test/meta-app-binding.spec.ts
 */
import { describe, expect, it } from "vitest";

import { classifyMetaAppBinding } from "@/lib/providers/meta-app-binding";

describe("an account with no stored secret", () => {
  it("is `unset` — not falsely reported as sharing the app", () => {
    // "unset" has to read as "we can't tell / nothing is signing this", because
    // calling it `shared_app` would promise an admin that a rotation fixes it.
    expect(classifyMetaAppBinding(null, "shared-secret")).toBe("unset");
    expect(classifyMetaAppBinding(null, null)).toBe("unset");
    expect(classifyMetaAppBinding("", "shared-secret")).toBe("unset");
  });
});

describe("an account whose secret matches the shared app", () => {
  it("is on the shared app, so a rotation reaches it", () => {
    expect(classifyMetaAppBinding("same-secret", "same-secret")).toBe("shared_app");
  });
});

describe("an account whose secret differs", () => {
  it("is on its OWN app — the case a rotation must skip", () => {
    expect(classifyMetaAppBinding("its-own-secret", "shared-secret")).toBe("own_app");
  });

  it("is on its own app even when no shared app is configured", () => {
    // It has a working secret and there is no shared app it could have inherited
    // from, so the credentials can only have come from elsewhere.
    expect(classifyMetaAppBinding("its-own-secret", null)).toBe("own_app");
  });

  it("distinguishes on the FULL secret, not a prefix", () => {
    // Two apps' secrets can share a prefix; treating them as equal would let a
    // rotation overwrite an own-app account and take its inbound dark.
    expect(classifyMetaAppBinding("abc123", "abc")).toBe("own_app");
    expect(classifyMetaAppBinding("abc", "abc123")).toBe("own_app");
  });
});

describe("the rotation's own guard is preserved", () => {
  it("treats adopting a FIRST shared app as everyone taking it", () => {
    // `resyncChannels` skips only when a PREVIOUS shared secret existed. This
    // documents why that extra condition is not redundant with the classifier:
    // on its own, the classifier calls this account `own_app` (correctly — it has
    // a secret and there is no shared app), but at rotation time "no previous
    // shared app" means the workspace is adopting one for the first time and every
    // account should take it. The guard lives at the call site, and this pins the
    // asymmetry so a future simplification doesn't quietly delete it.
    expect(classifyMetaAppBinding("some-secret", null)).toBe("own_app");
  });
});

/**
 * Forward-compat guard for Embedded Signup.
 *
 * Under ES the BYO-app assumption inverts: a Tech Provider has exactly ONE app (its
 * own), so an ES-onboarded account has NO `appSecret` on its row — the platform
 * app's secret signs its webhooks and lives in env. `classifyMetaAppBinding` then
 * returns `unset`, which the settings UI renders as a warning ("No Meta app
 * credentials") — a false alarm on the happy path, on every ES account.
 *
 * This test does not pretend to fix that (nothing can produce an ES row yet). It
 * PINS the current answer so the day someone adds `platform_app`, this assertion
 * fails and points them at the UI copy that has to change with it.
 */
describe("Embedded Signup (not built yet)", () => {
  it("an ES-shaped account — no own secret — still classifies as `unset` today", () => {
    // When ES lands: this becomes "platform_app", chosen from
    // WhatsappPortfolio.source === "embedded_signup" BEFORE the unset check, and
    // the warning copy in meta-app-accounts.tsx / channel-accounts-panel.tsx must
    // stop treating a missing row secret as a misconfiguration.
    expect(classifyMetaAppBinding(null, null)).toBe("unset");
  });
});
