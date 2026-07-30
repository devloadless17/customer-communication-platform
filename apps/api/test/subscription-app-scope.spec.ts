/**
 * A `subscribed_apps` response describes EVERY app on the object, not us.
 *
 * Both Meta subscription endpoints return a list of apps:
 *
 *   GET /{waba-id}/subscribed_apps  → `data[].whatsapp_business_api_data.id`
 *   GET /{page-id}/subscribed_apps  → "a list of Application nodes", each with
 *                                      its OWN `subscribed_fields`
 *
 * The reference for the first one literally ships a "Multiple apps subscribed to
 * WABA" example, and a shared object is ordinary: Coexistence and partner
 * onboarding both leave another BSP subscribed, and a Page often still carries a
 * previous vendor's app. Reading either response as "non-empty ⇒ we are
 * subscribed" therefore answers a question nobody asked, and answers it wrong in
 * the one case that matters — OUR app absent, receiving nothing, reported healthy.
 *
 * The Page half was worse than a bad reading. `ensurePageSubscribedToMessaging`
 * takes an early return when nothing is missing, and "missing" came from the union
 * over all apps — so when another app happened to hold `messages`, the repair path
 * concluded there was nothing to do and never subscribed us at all. A self-heal
 * that silently no-ops in exactly the situation it was written for.
 *
 * None of this can be caught by types or by a green Graph call: the payload shape
 * is valid, the status is 200, and no field says which id is ours.
 *
 *   pnpm --filter @ccp/api exec vitest run test/subscription-app-scope.spec.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/providers/meta-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/meta-graph")>();
  return { ...actual, graphGetJson: vi.fn(), graphPostForm: vi.fn() };
});

import { graphGetJson, graphPostForm } from "@/lib/providers/meta-graph";
import {
  ensurePageSubscribedToMessaging,
  getPageSubscription,
  PAGE_MESSAGING_FIELDS,
} from "@/lib/providers/meta-page-subscription";
import { isAppSubscribedToWaba } from "@/lib/providers/meta-waba-subscription";

const OURS = "our_app_id";
const THEIRS = "another_bsp_app_id";

const mockedGet = vi.mocked(graphGetJson);
const mockedPost = vi.mocked(graphPostForm);

/** A WABA `subscribed_apps` row, in Meta's nested shape. */
function wabaRow(appId: string) {
  return { whatsapp_business_api_data: { id: appId, name: appId, link: "https://x" } };
}

/** Fields posted in a `graphPostForm` call, in call order. */
function postedFields(): string[][] {
  return mockedPost.mock.calls.map(([, , form]) => {
    const raw = form instanceof FormData ? form.get("subscribed_fields") : null;
    return typeof raw === "string" ? raw.split(",") : [];
  });
}

beforeEach(() => {
  mockedGet.mockReset();
  mockedPost.mockReset();
});

describe("isAppSubscribedToWaba", () => {
  it("is false when nobody is subscribed", () => {
    expect(isAppSubscribedToWaba({ data: [] }, OURS)).toBe(false);
  });

  it("is FALSE when only another BSP is subscribed", () => {
    // The whole point. `data.length > 0` said true here.
    expect(isAppSubscribedToWaba({ data: [wabaRow(THEIRS)] }, OURS)).toBe(false);
  });

  it("is true when we are among several", () => {
    expect(isAppSubscribedToWaba({ data: [wabaRow(THEIRS), wabaRow(OURS)] }, OURS)).toBe(true);
  });

  it("falls back to any-app when our id is unknown", () => {
    // A connection stored before the app id was captured. Refusing to answer
    // would take the detector down for those rows; a weaker check beats none.
    expect(isAppSubscribedToWaba({ data: [wabaRow(THEIRS)] }, undefined)).toBe(true);
    expect(isAppSubscribedToWaba({ data: [] }, undefined)).toBe(false);
  });

  it("does not cry wolf on a shape it cannot read", () => {
    // If Meta moves the id, flagging every connection at once is a worse failure
    // than missing a subscription gap — an alert nobody can act on.
    expect(isAppSubscribedToWaba({ data: [{ unexpected: true }] }, OURS)).toBe(true);
  });

  it("tolerates a numeric id and a missing data key", () => {
    expect(isAppSubscribedToWaba({ data: [{ whatsapp_business_api_data: { id: 42 } }] }, "42")).toBe(
      true,
    );
    expect(isAppSubscribedToWaba({}, OURS)).toBe(false);
  });
});

describe("getPageSubscription is scoped to our app", () => {
  it("ignores another app's fields", async () => {
    mockedGet.mockResolvedValue({
      data: [
        { id: THEIRS, subscribed_fields: [...PAGE_MESSAGING_FIELDS] },
        { id: OURS, subscribed_fields: ["name"] },
      ],
    });

    const status = await getPageSubscription("page_1", "tok", "v26.0", OURS);

    expect(status.scopedToApp).toBe(true);
    expect(status.receivesMessages, "our app holds only `name`").toBe(false);
    expect(status.missingFields).toContain("messages");
  });

  it("reports not-subscribed when our app has no node at all", async () => {
    mockedGet.mockResolvedValue({
      data: [{ id: THEIRS, subscribed_fields: [...PAGE_MESSAGING_FIELDS] }],
    });

    const status = await getPageSubscription("page_1", "tok", "v26.0", OURS);

    expect(status.receivesMessages).toBe(false);
    expect(status.subscribedFields).toEqual([]);
  });

  it("unions across apps only when no app id is known", async () => {
    mockedGet.mockResolvedValue({
      data: [
        { id: THEIRS, subscribed_fields: ["messages"] },
        { id: OURS, subscribed_fields: ["name"] },
      ],
    });

    const status = await getPageSubscription("page_1", "tok", "v26.0");

    expect(status.scopedToApp).toBe(false);
    expect(status.receivesMessages).toBe(true);
  });
});

describe("ensurePageSubscribedToMessaging repairs OUR subscription", () => {
  it("subscribes us even when another app already holds every field", async () => {
    // The silent no-op: the early return fired on the union, so the one repair
    // path did nothing while our app stayed unsubscribed and inbound stayed dark.
    mockedGet.mockResolvedValue({
      data: [{ id: THEIRS, subscribed_fields: [...PAGE_MESSAGING_FIELDS] }],
    });
    mockedPost.mockResolvedValue({});

    const res = await ensurePageSubscribedToMessaging("page_1", "tok", "v26.0", OURS);

    expect(res.ok).toBe(true);
    expect(mockedPost, "no POST means our app was never subscribed").toHaveBeenCalled();
    expect(postedFields()[0]).toEqual(expect.arrayContaining(["messages"]));
  });

  it("extends OUR field set, never another app's", async () => {
    // Property (1) of the module: POST REPLACES our set, so the union must be
    // over our own current fields — Messenger and Instagram share one Page and
    // one app, and dropping the sibling's fields takes its inbound dark. Another
    // app's fields have no business in our POST.
    mockedGet.mockResolvedValue({
      data: [
        { id: OURS, subscribed_fields: ["name", "feed"] },
        { id: THEIRS, subscribed_fields: ["leadgen"] },
      ],
    });
    mockedPost.mockResolvedValue({});

    await ensurePageSubscribedToMessaging("page_1", "tok", "v26.0", OURS);

    const posted = postedFields()[0] ?? [];
    expect(posted, "our unrelated fields are preserved").toEqual(
      expect.arrayContaining(["name", "feed", "messages"]),
    );
    expect(posted, "another app's field must not be adopted").not.toContain("leadgen");
  });

  it("stays a no-op when our own subscription is already complete", async () => {
    mockedGet.mockResolvedValue({
      data: [
        {
          id: OURS,
          subscribed_fields: [
            ...PAGE_MESSAGING_FIELDS,
            // Mirror PAGE_OPTIONAL_FIELDS. `messaging_seen` used to be here; it is
            // not a `page` field at all (it belongs to the app-level `instagram`
            // topic), so it was removed from the array and from this fixture.
            "calls",
            "call_permission_reply",
            "response_feedback",
          ],
        },
      ],
    });

    const res = await ensurePageSubscribedToMessaging("page_1", "tok", "v26.0", OURS);

    expect(res.ok).toBe(true);
    expect(mockedPost).not.toHaveBeenCalled();
  });
});
