/**
 * Messenger call-permission read — the field is `can_perform_action`.
 *
 * `checkSocialCallPermission` used to read `can_perform`, which appears on no
 * documented Meta response, so `canStartCall` and `canRequestPermission` were
 * hard-false for every consumer, permanently. The WhatsApp twin of this same
 * lookup (`getCallPermission` in meta.ts) has always read the correct key — two
 * copies of one resolver drifted apart, and only the social one was wrong.
 *
 * It also used `=== true`, which made an ABSENT action entry indistinguishable
 * from an explicit denial. Meta omits the array where an action is simply
 * unconstrained, so that failed CLOSED and hid the affordance with no way to
 * recover. The WhatsApp side defaults open; these tests pin that both do.
 *
 * Latent in production only because `CHANNEL_CAPABILITIES.messenger.calling` is
 * false — Messenger calling is limited-availability, not GA. This must be correct
 * before that flag is flipped.
 *
 *   pnpm --filter @ccp/api exec vitest run test/social-call-permission.spec.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/providers/meta-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/meta-graph")>();
  return { ...actual, graphGetJson: vi.fn() };
});

import { graphGetJson } from "@/lib/providers/meta-graph";
import { checkSocialCallPermission } from "@/lib/providers/meta-social";

const mockedGet = vi.mocked(graphGetJson);

const TARGET = {
  accountId: "PAGE_1",
  accessToken: "tok",
  graphVersion: "v26.0",
  label: "messenger",
} as Parameters<typeof checkSocialCallPermission>[1];

describe("checkSocialCallPermission", () => {
  beforeEach(() => mockedGet.mockReset());

  it("reads `can_perform_action`, the documented field name", async () => {
    mockedGet.mockResolvedValue({
      permission: { status: "has_permission", expiration_time: 1_800_000_000 },
      actions: [
        { action_name: "start_call", can_perform_action: true },
        { action_name: "send_call_permission_request", can_perform_action: false },
      ],
    });

    const res = await checkSocialCallPermission("PSID_1", TARGET);
    expect(res.hasPermission).toBe(true);
    expect(res.canStartCall, "true must survive the read").toBe(true);
    // An explicit false is still honoured — the fail-open default must not
    // override a denial Meta actually stated.
    expect(res.canRequestPermission).toBe(false);
    expect(res.expiresAt?.getTime()).toBe(1_800_000_000 * 1000);
  });

  it("does not go blind when only the short `can_perform` alias is present", async () => {
    mockedGet.mockResolvedValue({
      permission: { status: "has_permission" },
      actions: [{ action_name: "start_call", can_perform: true }],
    });
    const res = await checkSocialCallPermission("PSID_1", TARGET);
    expect(res.canStartCall).toBe(true);
  });

  it("defaults OPEN when the actions array is absent, matching the WhatsApp side", async () => {
    // Meta omits `actions` when nothing constrains them. `=== true` treated that
    // as a denial, so a consumer who HAD granted permission still could not be
    // called and the UI offered no route forward.
    mockedGet.mockResolvedValue({ permission: { status: "has_permission" } });
    const res = await checkSocialCallPermission("PSID_1", TARGET);
    expect(res.canStartCall).toBe(true);
    expect(res.canRequestPermission).toBe(true);
  });

  it("still reports no-permission as not-callable, but requestable", async () => {
    mockedGet.mockResolvedValue({ permission: { status: "no_permission" } });
    const res = await checkSocialCallPermission("PSID_1", TARGET);
    expect(res.hasPermission).toBe(false);
    expect(res.canStartCall, "cannot call without permission").toBe(false);
    // Asking for permission is exactly the recovery path — it must stay available.
    expect(res.canRequestPermission).toBe(true);
  });
});
