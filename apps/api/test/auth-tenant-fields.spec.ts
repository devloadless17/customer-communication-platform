import { getAuthTables } from "better-auth/db";
import { describe, expect, it } from "vitest";

import { buildSharedAuthOptions } from "@ccp/shared/auth/better-auth-config";

/**
 * Better Auth only writes columns it has been TOLD about.
 *
 * Its adapter builds every INSERT with
 * `for (const field in schema.user.fields)` (`transformInput`, @better-auth/core
 * db/adapter/factory) — a key that is not in this map is dropped from the
 * payload with no warning, no error and no log. The `databaseHooks.user.create
 * .before` hook injects `organizationId` for a first-time Google user, and
 * before these fields were declared that injection evaporated between the hook
 * and Prisma. `User.organizationId` is required with no default, so the insert
 * died as `Argument 'organization' is missing` and every "Continue with Google"
 * dead-ended at `unable_to_create_user` — with the hook itself looking correct.
 *
 * Asserted against the RESOLVED schema rather than the literal config, because
 * that resolved map is what the adapter actually iterates.
 */

const options = buildSharedAuthOptions({
  passwordHash: async (p: string) => p,
  passwordVerify: async () => true,
});
const userFields = getAuthTables(options).user.fields as Record<
  string,
  { type?: unknown; input?: boolean } | undefined
>;

describe("Better Auth user schema carries tenant scope", () => {
  it("declares organizationId, or no social signup can ever be inserted", () => {
    expect(userFields.organizationId).toBeDefined();
  });

  it("declares orgRole, or the org's CREATOR is written as a plain member", () => {
    // Quieter than the above and therefore worse: `orgRole` defaults to
    // `member`, so a dropped value does not fail the insert — the founder just
    // silently loses ownership of the organization they just created.
    expect(userFields.orgRole).toBeDefined();
  });

  it("keeps both server-assigned — a client must not name its own tenant", () => {
    // Writable, a crafted signup body could set `organizationId` and join an
    // arbitrary existing organization. `input: false` makes Better Auth reject
    // a request that tries; the database hook runs after input parsing and
    // merges straight into the adapter call, so it is unaffected.
    expect(userFields.organizationId?.input).toBe(false);
    expect(userFields.orgRole?.input).toBe(false);
  });

  it("still maps image → avatarUrl", () => {
    // Declaring additionalFields replaces nothing, but the two live in the same
    // `user` block and clobbering `fields` here would silently stop avatars
    // persisting.
    expect(getAuthTables(options).user.fields.image?.fieldName).toBe("avatarUrl");
  });
});
