import { describe, expect, it } from "vitest";

import { parseBlockUsersResponse } from "@/lib/providers/meta";

/**
 * Block Users API response parsing (block-users doc). The load-bearing rule
 * pinned here: a MIXED response carries per-user failures AND a top-level
 * OAuth-style error (#139100) in the SAME body — the top-level error must
 * never be read as "the whole call failed" when the ledger is present.
 */

describe("parseBlockUsersResponse", () => {
  it("parses the doc's all-success block example", () => {
    const out = parseBlockUsersResponse({
      messaging_product: "whatsapp",
      block_users: {
        added_users: [
          { input: "+16505551234", wa_id: "16505551234" },
          { input: "+14155559876", wa_id: "14155559876" },
        ],
      },
    } as never);
    expect(out.succeeded).toHaveLength(2);
    expect(out.failed).toHaveLength(0);
    expect(out.succeeded[0]).toEqual({
      input: "+16505551234",
      externalUserId: "16505551234",
      error: null,
    });
  });

  it("parses the doc's MIXED example — partial success survives the top-level #139100 error", () => {
    const out = parseBlockUsersResponse({
      messaging_product: "whatsapp",
      block_users: {
        added_users: [{ input: "+16505551234", wa_id: "16505551234" }],
        failed_users: [
          {
            input: "+14155559876",
            wa_id: "14155559876",
            errors: [
              {
                message: "Re-engagement required",
                code: 131047,
                error_data: { details: "User has not messaged in the last 24 hours" },
              },
            ],
          },
        ],
      },
      error: {
        message: "(#139100) Failed to block/unblock users",
        code: 139100,
      },
    } as never);
    expect(out.succeeded).toHaveLength(1);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]?.error).toEqual({
      code: 131047,
      message: "Re-engagement required",
      details: "User has not messaged in the last 24 hours",
    });
  });

  it("maps unblock's removed_users to succeeded (same ledger, DELETE direction)", () => {
    const out = parseBlockUsersResponse({
      messaging_product: "whatsapp",
      block_users: {
        removed_users: [{ input: "+16505551234", wa_id: "16505551234" }],
      },
    } as never);
    expect(out.succeeded).toHaveLength(1);
    expect(out.failed).toHaveLength(0);
  });

  it("keeps a failure with no wa_id (invalid number — the doc says wa_id may be absent)", () => {
    const out = parseBlockUsersResponse({
      block_users: {
        failed_users: [
          {
            input: "+1000",
            errors: [{ message: "Re-engagement required", code: 131047 }],
          },
        ],
      },
    } as never);
    expect(out.failed[0]?.externalUserId).toBeNull();
    expect(out.failed[0]?.error?.details).toBeNull();
  });
});
