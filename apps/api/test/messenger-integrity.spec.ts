/**
 * Page Integrity — the signal that explains a Messenger outage BEFORE it starts.
 *
 * `normalizeMetaSendError` classifies `10 – 1893063` as `account_restricted`, but
 * only once a send has already failed. `restrictions[]` carries the same fact
 * with an expiry and an appeal link ahead of time, so these tests pin the two
 * things that decide whether that warning is trustworthy: that a restriction is
 * recognised as blocking, and that a LIFT is not mistaken for one.
 *
 *   pnpm --filter @ccp/api exec vitest run test/messenger-integrity.spec.ts
 */
import { describe, expect, it } from "vitest";

import {
  blocksMessaging,
  messagingRestrictionExpiry,
  parsePageIntegrity,
} from "@/lib/providers/messenger-integrity";
import { parseSocialMessaging } from "@/lib/providers/meta-social";

describe("parsePageIntegrity", () => {
  it("reads the API shape, normalizing Unix seconds", () => {
    const integrity = parsePageIntegrity({
      id: "PAGE_1",
      timestamp: 1_763_665_904,
      status: "restricted",
      violations: [
        { type: "SPAM", description: "Page posted content…", url: "https://fb.test/spam" },
      ],
      restrictions: [
        {
          feature: "page_messaging_api",
          description: "restricted from sending messages for 3 days",
          applied_time: 1_763_665_904,
          expiration_time: 1_763_675_775,
          violation_type: ["SPAM"],
        },
      ],
      recommended_actions: [
        { action_type: "FILE_APPEAL", url: "https://fb.test/appeal", violation_type: ["SPAM"] },
      ],
      // The API spells this `actions_events`; the webhook spells it
      // `action_events`. Both are read — see the module header.
      actions_events: [
        { type: "FILE_APPEAL", status: "OPEN", created_time: 1_763_666_000, updated_time: 0 },
      ],
    });

    expect(integrity.status).toBe("restricted");
    expect(integrity.timestamp).toBe(new Date(1_763_665_904 * 1000).toISOString());
    expect(integrity.violations[0]).toMatchObject({ type: "SPAM", url: "https://fb.test/spam" });
    expect(integrity.restrictions[0]!.expiresAt).toBe(
      new Date(1_763_675_775 * 1000).toISOString(),
    );
    expect(integrity.appeals[0]).toMatchObject({ type: "FILE_APPEAL", status: "OPEN" });
    // 0 is not a timestamp — it must not become 1970.
    expect(integrity.appeals[0]!.updatedAt).toBeNull();

    expect(blocksMessaging(integrity)).toBe(true);
    expect(messagingRestrictionExpiry(integrity)).toBe(
      new Date(1_763_675_775 * 1000).toISOString(),
    );
  });

  it("does NOT treat an UNRESTRICTED row as a block", () => {
    // Meta announces a LIFT as a restriction row with status UNRESTRICTED. Keying
    // on the row's presence would report a Page as blocked at the exact moment it
    // was freed — and keep reporting it forever.
    const integrity = parsePageIntegrity({
      status: "ok",
      restrictions: [
        {
          feature: "page_messaging_api",
          status: "UNRESTRICTED",
          description: "no longer restricted",
          applied_time: 1_760_978_516,
        },
      ],
    });
    expect(blocksMessaging(integrity)).toBe(false);
    expect(messagingRestrictionExpiry(integrity)).toBeNull();
  });

  it("ignores a non-messaging restriction", () => {
    // `page_read_only` and `page_publish` are real enforcements that say nothing
    // about replying. Alarming "you cannot reply" over a posting restriction is
    // false, and false alarms are how a banner gets ignored.
    const integrity = parsePageIntegrity({
      status: "restricted",
      restrictions: [{ feature: "page_read_only", status: "RESTRICTED" }],
    });
    expect(blocksMessaging(integrity)).toBe(false);
  });

  it("merges restrictions from the entry level, where Meta sometimes puts them", () => {
    // One documented webhook example nests `restrictions` inside the messaging
    // item; another hangs it off the entry. Reading only one position loses half
    // the real payloads.
    const integrity = parsePageIntegrity(
      { status: "ok", violations: [{ type: "SPAM" }] },
      {
        restrictions: [
          { feature: "page_messaging", status: "RESTRICTED", expiration_time: 1_761_064_276 },
        ],
      },
    );
    expect(blocksMessaging(integrity)).toBe(true);
  });
});

describe("integrity webhooks are parsed, not swallowed", () => {
  // Both integrity and policy-enforcement notices ride `entry[].messaging[]` —
  // the same array customer messages arrive on — with no sender and no mid. The
  // parser must consume them, or they fall into the catch-all `unhandled_messaging`
  // warn at severity "info", i.e. we pay for the subscription and discard it.
  it("emits no message events for a business_integrity payload", () => {
    const events = parseSocialMessaging(
      {
        object: "page",
        entry: [
          {
            time: 1_761_804_073_668,
            id: "PAGE_1",
            messaging: [
              {
                timestamp: 1_761_803_759,
                status: "restricted",
                violations: [
                  { type: "CYBERSECURITY", description: "…", url: "https://transparency.test" },
                ],
              },
            ],
          },
        ],
      },
      "page",
    );
    expect(events).toEqual([]);
  });

  it("emits no message events for a messaging_policy_enforcement payload", () => {
    const events = parseSocialMessaging(
      {
        object: "page",
        entry: [
          {
            time: 1_761_804_073_668,
            id: "PAGE_1",
            messaging: [
              {
                recipient: { id: "PAGE_1" },
                timestamp: 1_761_803_759,
                policy_enforcement: { action: "block", reason: "Policy violation" },
              },
            ],
          },
        ],
      },
      "page",
    );
    expect(events).toEqual([]);
  });

  it("still parses an ordinary inbound message alongside these branches", () => {
    // The guard above keys on `status` + one of the integrity arrays. A normal
    // message has neither, so it must be untouched — this is the regression that
    // would matter most if the condition were ever loosened.
    const events = parseSocialMessaging(
      {
        object: "page",
        entry: [
          {
            id: "PAGE_1",
            messaging: [
              {
                sender: { id: "PSID_1" },
                recipient: { id: "PAGE_1" },
                timestamp: 1_700_000_000_000,
                message: { mid: "m_1", text: "hello" },
              },
            ],
          },
        ],
      },
      "page",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "message", body: "hello" });
  });
});

describe("handover protocol webhooks", () => {
  // Same trap as the integrity events: `messaging_handovers` rides
  // `entry[].messaging[]` with no message and no mid, so an unparsed payload
  // lands in the catch-all `unhandled_messaging` warn at severity "info".
  it.each([
    ["pass_thread_control", { previous_owner_app_id: null, new_owner_app_id: "123" }],
    ["take_thread_control", { previous_owner_app_id: "123", new_owner_app_id: "456" }],
    ["request_thread_control", { requested_owner_app_id: 789 }],
  ])("consumes %s without emitting a message", (field, value) => {
    const events = parseSocialMessaging(
      {
        object: "page",
        entry: [
          {
            id: "PAGE_1",
            messaging: [
              {
                sender: { id: "PSID_1" },
                recipient: { id: "PAGE_1" },
                timestamp: 1_458_692_752_478,
                [field]: value,
              },
            ],
          },
        ],
      },
      "page",
    );
    expect(events).toEqual([]);
  });

  it("consumes an app_roles change", () => {
    const events = parseSocialMessaging(
      {
        object: "page",
        entry: [
          {
            id: "PAGE_1",
            messaging: [
              {
                recipient: { id: "PSID_1" },
                timestamp: 1_458_692_752_478,
                app_roles: { "123456789": ["primary_receiver"] },
              },
            ],
          },
        ],
      },
      "page",
    );
    expect(events).toEqual([]);
  });
});
