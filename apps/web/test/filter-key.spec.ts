/**
 * `conversationFilterKey` — the identity of "what list am I looking at".
 *
 * This exists because of a real data-loss path found in the verification
 * program (2026-07-29). The key was built inline from `filter` alone, and the
 * ACCOUNT narrow is a second, independent dimension that lives in the filter
 * context. Switching Sales → Support therefore produced a byte-identical key,
 * so the effect that clears `selectedIds` never fired: the checkboxes kept ids
 * for rows no longer on screen while the header still read "N selected", and
 * `bulkDelete()` posts exactly those ids to `/api/conversations/bulk` — which
 * removes every message and note on them, and says so ("This can't be undone").
 *
 * The property that matters is not "the key contains the account id" — it is
 * **any change to any narrow must change the key**. So these assert
 * DISTINCTNESS across dimensions rather than exact strings, which is what keeps
 * the test honest when a future dimension is added.
 *
 *   pnpm --filter @ccp/web exec vitest run test/filter-key.spec.ts
 */
import { describe, expect, it } from "vitest";

import { conversationFilterKey } from "@/features/inbox/lib/filter-key";
import type { Filter } from "@/features/inbox/components/inbox-controls";

const ACTIVE: Filter = { kind: "preset", id: "active" };
const CLOSED: Filter = { kind: "preset", id: "closed" };
const STAGE_A: Filter = { kind: "stage", stageId: "stg_a" };
const STAGE_B: Filter = { kind: "stage", stageId: "stg_b" };
const CALLS: Filter = { kind: "calls" };

describe("conversationFilterKey", () => {
  it("changes when the ACCOUNT narrow changes — the regression this exists for", () => {
    const sales = conversationFilterKey(ACTIVE, "conn_sales");
    const support = conversationFilterKey(ACTIVE, "conn_support");
    expect(sales).not.toBe(support);
  });

  it("changes between 'all accounts' and a specific account, in both directions", () => {
    const all = conversationFilterKey(ACTIVE, null);
    const one = conversationFilterKey(ACTIVE, "conn_sales");
    expect(all).not.toBe(one);
    // undefined and null both mean "no narrow" and must agree, or entering the
    // inbox would look like a filter change and clear a fresh selection.
    expect(conversationFilterKey(ACTIVE, undefined)).toBe(all);
  });

  it("still changes on every pre-existing dimension", () => {
    const keys = [
      conversationFilterKey(ACTIVE, null),
      conversationFilterKey(CLOSED, null),
      conversationFilterKey(STAGE_A, null),
      conversationFilterKey(STAGE_B, null),
      conversationFilterKey(CALLS, null),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is stable for the same inputs", () => {
    expect(conversationFilterKey(STAGE_A, "conn_x")).toBe(
      conversationFilterKey(STAGE_A, "conn_x"),
    );
  });

  it("cannot collide across dimensions — an account id must not imitate a stage", () => {
    // A key built by naive concatenation can alias: stage "a" + account "b"
    // colliding with stage "a|b" + no account would silently re-introduce the
    // bug for one unlucky pair of ids.
    const a = conversationFilterKey({ kind: "stage", stageId: "a" }, "b");
    const b = conversationFilterKey({ kind: "stage", stageId: "a|b" }, null);
    expect(a).not.toBe(b);
  });

  it("every (filter × account) pair is distinct", () => {
    const filters = [ACTIVE, CLOSED, STAGE_A, STAGE_B, CALLS];
    const accounts = [null, "conn_sales", "conn_support"];
    const keys = filters.flatMap((f) => accounts.map((a) => conversationFilterKey(f, a)));
    expect(new Set(keys).size).toBe(filters.length * accounts.length);
  });
});
