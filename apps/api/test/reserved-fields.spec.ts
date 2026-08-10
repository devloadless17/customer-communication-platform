/**
 * Reserved custom-field names — pins the "Source" split rationale.
 *
 * `source` was un-reserved on 2026-08-10: `Contact.source` is the
 * inbound/manual acquisition enum, not a panel column, so a custom "Source"
 * dimension shadows nothing an agent sees twice — and "Source" is the very
 * name the select-field feature was built for. The safety of that decision
 * rests on the CSV layer treating the label as COLLIDING (so export emits it
 * under the `custom:<key>` header instead of a duplicate `source` column) —
 * which is exactly the split this spec pins. If either side flips, re-read
 * the comment block in reserved-fields.ts before "fixing" the test.
 *
 *   pnpm --filter @ccp/api exec vitest run test/reserved-fields.spec.ts
 */
import { describe, expect, it } from "vitest";

import { isReservedFieldKey } from "@ccp/shared/contacts/reserved-fields";
import { collidesWithBuiltinColumn } from "@ccp/shared/contacts/transfer-columns";

describe("the Source split", () => {
  it("allows 'Source' as a custom-field name…", () => {
    expect(isReservedFieldKey("Source")).toBe(false);
    expect(isReservedFieldKey("source")).toBe(false);
  });

  it("…while the CSV layer still routes the label through the custom: prefix", () => {
    // The builtin export-only `source` column collides by label, so
    // fieldHeader() emits `custom:<key>` and the round-trip stays loss-free.
    expect(collidesWithBuiltinColumn("Source")).toBe(true);
    expect(collidesWithBuiltinColumn("source")).toBe(true);
  });
});

describe("still-reserved names", () => {
  it("keeps blocking names that shadow real panel columns or system concepts", () => {
    for (const name of ["Phone", "First name", "Email", "Location", "Stage", "Tags", "Channel"]) {
      expect(isReservedFieldKey(name), name).toBe(true);
    }
  });

  it("catches separator variants", () => {
    expect(isReservedFieldKey("PhoneNumber")).toBe(true);
    expect(isReservedFieldKey("first_name")).toBe(true);
  });
});
