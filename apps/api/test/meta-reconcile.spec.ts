/**
 * Meta reconciliation — comparator core. Pure-function spec: the verdict
 * rules are what the reconcile script's output means, so they are pinned
 * here independent of any I/O.
 *
 *   pnpm --filter @ccp/api exec vitest run test/meta-reconcile.spec.ts
 */
import { describe, expect, it } from "vitest";

import {
  compareField,
  compareTemplates,
  infoRow,
  manualRow,
  summarize,
} from "@/lib/providers/meta-reconcile";

describe("compareField", () => {
  it("matches case-insensitively and treats empty as absent", () => {
    expect(compareField({ entity: "e", field: "f", system: "GREEN", meta: "green" }).verdict).toBe("match");
    expect(compareField({ entity: "e", field: "f", system: "", meta: null }).verdict).toBe("match");
    expect(compareField({ entity: "e", field: "f", system: "  ", meta: undefined }).verdict).toBe("match");
  });

  it("reports stale when the system never stored what Meta has", () => {
    const r = compareField({ entity: "e", field: "f", system: null, meta: "APPROVED" });
    expect(r.verdict).toBe("stale");
  });

  it("reports drift when both sides disagree, keeping the heal path", () => {
    const r = compareField({ entity: "e", field: "f", system: "TIER_250", meta: "TIER_2K", heal: "x" });
    expect(r.verdict).toBe("drift");
    expect(r.heal).toBe("x");
  });

  it("system-only value (Meta lost it) is drift, not match", () => {
    expect(compareField({ entity: "e", field: "f", system: "kept", meta: null }).verdict).toBe("drift");
  });
});

describe("compareTemplates", () => {
  const t = (name: string, status: string | null, category: string | null = "marketing") => ({
    name,
    language: "en",
    status,
    category,
    qualityScore: null,
    parameterFormat: "positional" as string | null,
  });

  it("diffs Meta-owned fields per (name, language) and flags both directions", () => {
    const rows = compareTemplates(
      "waba X",
      [t("hello", "approved"), t("gone", "approved")],
      [t("hello", "paused"), t("brand_new", "approved")],
    );
    const drifts = rows.filter((r) => r.verdict === "drift");
    // hello status approved→paused, plus the locally-stored-but-absent "gone".
    expect(drifts.some((r) => r.field === "template hello/en status")).toBe(true);
    expect(drifts.some((r) => r.field === "template gone/en")).toBe(true);
    expect(rows.some((r) => r.verdict === "stale" && r.field === "template brand_new/en")).toBe(true);
    // Matching fields still counted as matches, not silence.
    expect(rows.some((r) => r.verdict === "match" && r.field === "template hello/en category")).toBe(true);
  });
});

describe("summarize + row constructors", () => {
  it("counts verdicts and manual/info rows never claim a system value", () => {
    const rows = [
      compareField({ entity: "e", field: "a", system: "x", meta: "x" }),
      manualRow({ entity: "e", field: "b", meta: "DISCONNECTED", note: "register" }),
      infoRow({ entity: "e", field: "c", meta: "{...}" }),
    ];
    expect(rows[1]!.system).toBeNull();
    expect(summarize(rows)).toEqual({ match: 1, drift: 0, stale: 0, manual: 1, info: 1 });
  });
});
