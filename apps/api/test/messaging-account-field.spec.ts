/**
 * The Messages API billing parameter for Meta's new account model — and the
 * reason its NAME needs a test.
 *
 * Meta is splitting the legacy WABA into a **WAAC** (the phone number, 1:1) and a
 * **Messaging Account** (templates, billing, webhook subscriptions — keeping the
 * WABA's id). One phone number can carry several Messaging Accounts, one per
 * partner, and this parameter names the one to bill.
 *
 * TWO NAMES EXIST, AND THE GUIDE PAGES LAG THE CHANGELOG:
 *
 *   - The account-model-evolution guide still reads "a `paid_messaging_account_id`
 *     parameter becomes available on Messages API calls".
 *   - The **changelog entry of 2026-06-16 supersedes it**: "Added
 *     `messaging_account_id` as the preferred Cloud API parameter, with
 *     `paid_messaging_account_id` kept as a deprecated backward-compatible alias."
 *
 * This is not hypothetical: on 2026-07-30 the field was renamed to the guide's
 * spelling and reverted the same day once the changelog was read. Graph rejects an
 * unrecognised body field with `#100`, which fails the ENTIRE send for every tenant
 * — so this name is only ever safe to change against the CHANGELOG, never against a
 * guide page alone. That lesson is what these assertions defend.
 *
 * Also pinned: an unset value must emit NO key. The safety of the whole
 * forward-compat design is that the wire stays byte-identical until someone opts in,
 * and `{ messaging_account_id: undefined }` is exactly what a refactor introduces.
 *
 * Phases (verified 2026-07-30): optional at Phase 1 (H2 2026), required for
 * multi-Messaging-Account setups from Phase 2 (H1 2027), required everywhere at
 * Phase 3 (H1 2028).
 *
 *   pnpm --filter @ccp/api exec vitest run test/messaging-account-field.spec.ts
 */
import { describe, expect, it } from "vitest";

import { messagingAccountField } from "@/lib/providers/meta";
import type { MetaSendConfig } from "@/lib/providers/config";

const base = {
  phoneNumberId: "PHONE_1",
  accessToken: "tok",
  graphVersion: "v26.0",
} as MetaSendConfig;

describe("when no Messaging Account is configured (every tenant today)", () => {
  it("emits NO key at all — the wire stays byte-identical", () => {
    const out = messagingAccountField(base);

    expect(out).toEqual({});
    // Not merely undefined: the KEY must be absent, or a send body gains a field
    // Graph would reject with #100.
    expect(Object.keys(out)).toHaveLength(0);
    expect("messaging_account_id" in out).toBe(false);
  });

  it("treats an empty string as unset rather than sending a blank id", () => {
    expect(messagingAccountField({ ...base, messagingAccountId: "" })).toEqual({});
  });
});

describe("when a Messaging Account IS configured", () => {
  it("uses `messaging_account_id` — the changelog's preferred parameter", () => {
    expect(messagingAccountField({ ...base, messagingAccountId: "MA_123" })).toEqual({
      messaging_account_id: "MA_123",
    });
  });

  it("does NOT use the deprecated `paid_messaging_account_id` alias", () => {
    // The spelling the guide pages still show. Kept as an explicit negative so a
    // future "fix" against a stale guide page fails here instead of in production.
    const out = messagingAccountField({ ...base, messagingAccountId: "MA_123" }) as Record<
      string,
      unknown
    >;

    expect("paid_messaging_account_id" in out).toBe(false);
  });
});
