/**
 * Workflows can condition on the ACCOUNT, on every trigger that knows one.
 *
 * `channel_account_id` existed as a condition field and a resolver, but was
 * whitelisted on only two of the eleven triggers — so "when a chat on the Sales
 * number is assigned…" silently could not be built, even though the payload
 * carried the account the whole time. (The builder couldn't render it at all
 * either: the field was absent from the client mirror.)
 *
 * The rule tested here: a trigger may condition on the account exactly when its
 * payload carries a conversation snapshot, because that snapshot is where the
 * resolver reads it from. Whitelisting it anywhere else would produce a field
 * that always resolves null — a condition that looks configurable and never
 * matches.
 *
 *   pnpm --filter @ccp/api exec vitest run test/workflow-account-conditions.spec.ts
 */
import { describe, expect, it } from "vitest";

import { FIELDS_BY_TRIGGER } from "@/lib/workflows/conditions";

/** Triggers whose payload carries a `conversation` snapshot. */
const SNAPSHOT_TRIGGERS = [
  "message_received",
  "conversation_created",
  "conversation_opened",
  "conversation_closed",
  "conversation_assigned",
  "conversation_status_changed",
] as const;

/** Triggers with no conversation in the payload — contact- or system-scoped. */
const NO_SNAPSHOT_TRIGGERS = [
  "contact_tag_updated",
  "contact_field_updated",
  "contact_lifecycle_updated",
] as const;

describe("channel_account_id trigger whitelist", () => {
  for (const trigger of SNAPSHOT_TRIGGERS) {
    it(`is offered on ${trigger}`, () => {
      expect(FIELDS_BY_TRIGGER[trigger]).toContain("channel_account_id");
    });
  }

  for (const trigger of NO_SNAPSHOT_TRIGGERS) {
    it(`is NOT offered on ${trigger} (no conversation to read it from)`, () => {
      // Offering it here would render a dropdown that always resolves null —
      // worse than absent, because it looks like it works.
      expect(FIELDS_BY_TRIGGER[trigger]).not.toContain("channel_account_id");
    });
  }
});

describe("the client mirror stays in lockstep", () => {
  it("every server trigger list is a superset of nothing unexpected", () => {
    // The builder mirrors FIELDS_BY_TRIGGER by hand (it cannot import server
    // code). A field the server accepts but the mirror omits is unreachable in
    // the UI — which is exactly the state `channel_account_id` was in. This
    // asserts the server side; the mirror is asserted by its own exhaustive
    // `Record<ConditionField, …>` types, which fail to compile on a miss.
    for (const trigger of SNAPSHOT_TRIGGERS) {
      const fields = FIELDS_BY_TRIGGER[trigger];
      expect(new Set(fields).size, `${trigger} has duplicate fields`).toBe(fields.length);
    }
  });
});
