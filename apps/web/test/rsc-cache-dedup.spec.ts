import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The inbox LAYOUT and PAGE deliberately both call the same query functions
 * (the layout's comment records why), and the /organization tabs plus the
 * (app) layout lean on the same pattern: correctness of "one fetch per
 * request" rests ENTIRELY on those functions being wrapped in React's
 * `cache()`. Nothing type-level enforces that — removing a `cache(` wrapper
 * compiles clean and silently doubles every affected render's fan-out.
 *
 * This spec is the tripwire: for each dual-fetched function, assert the
 * SOURCE declares it through `cache(`. Source-scan rather than runtime,
 * because `React.cache` is a per-request server mechanism a unit test can't
 * observe — what CAN be pinned is the declaration shape the dedup depends on.
 */
const DUAL_FETCHED = [
  // inbox/layout.tsx + inbox/page.tsx (documented at inbox/layout.tsx)
  "getCurrentTeam",
  "listTeamMembers",
  "listContactStages",
  "listInboxViews",
  "listConversations",
  // (app)/layout.tsx + several pages
  "listChannelAccountDirectory",
  // the three /organization tabs
  "getOrganizationOverview",
] as const;

describe("RSC dual-fetch dedup", () => {
  const queries = readFileSync(
    join(__dirname, "../src/lib/api/queries.ts"),
    "utf8",
  );
  const currentUser = readFileSync(
    join(__dirname, "../src/lib/auth/current-user.ts"),
    "utf8",
  );

  for (const fn of DUAL_FETCHED) {
    it(`${fn} is React.cache()-wrapped`, () => {
      const declared = new RegExp(
        `export const ${fn}(?::[^=]+)? = cache(<[^>]*>)?\\(`,
      ).test(queries);
      expect(
        declared,
        `${fn} must be declared as \`export const ${fn} = cache(...)\` in queries.ts — it is fetched by more than one component per request, and without cache() each render doubles the fan-out`,
      ).toBe(true);
    });
  }

  it("getSession is React.cache()-wrapped", () => {
    expect(/export const getSession = cache\(/.test(currentUser)).toBe(true);
  });
});
