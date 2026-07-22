/**
 * Large-scale WhatsApp broadcast support — the NEW logic behind messaging-tier
 * eligibility gating + adaptive send pacing (see broadcast-runner.ts,
 * meta-health.ts, meta-send-error.ts). Two layers, both safe on this box:
 *
 *   1. Pure send-error classification — asserts the marketing/ template error
 *      codes route to their dedicated normalized codes (imported directly; the
 *      module is self-contained with no @/ deps).
 *   2. Number messaging-health webhooks END TO END — posts genuinely HMAC-signed
 *      `phone_number_quality_update` / `business_capability_update` payloads to
 *      the mock-backed test api (:4001) and asserts the committed tier snapshot
 *      on the WhatsApp ChannelConnection. This is the gate's data source.
 *
 * Runs against the throwaway META_TEST_TEAM_ID; never touches real data. Does NOT
 * wipe (mirrors outbound-send.spec.ts — only the terminal webhook-ingest spec
 * wipes, to respect the api's 60s provider-config cache).
 */

import { test, expect } from "@playwright/test";

import {
  MetaSendError,
  normalizeMetaSendError,
} from "../../../apps/api/src/lib/providers/meta-send-error";
import { db, pollUntil } from "../_helpers/db";
import { seedMetaTestTeam, postMetaWebhook, META_TEST_TEAM_ID, WA_WABA_ID } from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedMetaTestTeam();
});

/** Build a MetaSendError whose body carries a given numeric Meta error code. */
function metaErr(code: number): MetaSendError {
  return new MetaSendError(`meta failed`, 400, JSON.stringify({ error: { code } }));
}

test.describe("send-error classification for broadcast pacing", () => {
  test("131049 → per_user_marketing_cap (NOT rate_limited — per-user, non-retryable)", () => {
    const n = normalizeMetaSendError(metaErr(131049));
    expect(n?.code).toBe("per_user_marketing_cap");
  });

  test("paused/disabled/unapproved template codes → template_unavailable (run-fatal)", () => {
    for (const code of [132001, 132007, 132015, 132016]) {
      expect(normalizeMetaSendError(metaErr(code))?.code).toBe("template_unavailable");
    }
  });

  test("regression: throughput/spam codes still normalize to rate_limited", () => {
    for (const code of [4, 80007, 130429, 131048, 131056]) {
      expect(normalizeMetaSendError(metaErr(code))?.code).toBe("rate_limited");
    }
  });

  test("regression: 190 still auth_expired; unknown still provider_rejected", () => {
    expect(normalizeMetaSendError(metaErr(190))?.code).toBe("auth_expired");
    expect(normalizeMetaSendError(metaErr(999999))?.code).toBe("provider_rejected");
  });
});

/** Read the WhatsApp connection's cached messaging-health snapshot. */
async function waHealth() {
  return db().channelConnection.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, channel: "whatsapp", isDefault: true },
    select: {
      portfolio: { select: { messagingTier: true, messagingDailyCap: true } },
      qualityRating: true,
      throughputLevel: true,
    },
  });
}

/** A `whatsapp_business_account` webhook carrying one change field + value. */
function waWebhook(field: string, value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: WA_WABA_ID, changes: [{ field, value }] }],
  };
}

test.describe("number messaging-health webhooks update the tier snapshot", () => {
  test("phone_number_quality_update current_limit → tier + derived daily cap", async () => {
    const res = await postMetaWebhook(
      META_TEST_TEAM_ID,
      waWebhook("phone_number_quality_update", {
        display_phone_number: "15550001111",
        event: "UPGRADE",
        current_limit: "TIER_10K",
      }),
    );
    expect(res.status).toBe(200);
    await pollUntil(
      async () => {
        const h = await waHealth();
        return h?.portfolio?.messagingTier === "TIER_10K" && h?.portfolio?.messagingDailyCap === 10_000 ? h : null;
      },
      { label: "messagingTier=TIER_10K" },
    );
  });

  test("business_capability_update numeric cap → normalized 100K tier", async () => {
    const res = await postMetaWebhook(
      META_TEST_TEAM_ID,
      waWebhook("business_capability_update", {
        max_daily_conversation_per_phone: 100000,
        max_phone_numbers_per_business: 2,
      }),
    );
    expect(res.status).toBe(200);
    await pollUntil(
      async () => {
        const h = await waHealth();
        return h?.portfolio?.messagingTier === "TIER_100K" && h?.portfolio?.messagingDailyCap === 100_000 ? h : null;
      },
      { label: "messagingTier=TIER_100K" },
    );
  });

  test("account_alerts (no tier data) is accepted without blanking the snapshot", async () => {
    const before = await waHealth();
    const res = await postMetaWebhook(
      META_TEST_TEAM_ID,
      waWebhook("account_alerts", {
        entity_type: "PHONE_NUMBER",
        alert_severity: "WARNING",
        alert_status: "ACTIVE",
      }),
    );
    // Accepted (200) and the prior tier snapshot is untouched (parse returns null
    // → no channel_health event → no write).
    expect(res.status).toBe(200);
    const after = await waHealth();
    expect(after?.portfolio?.messagingTier).toBe(before?.portfolio?.messagingTier);
    expect(after?.portfolio?.messagingDailyCap).toBe(before?.portfolio?.messagingDailyCap);
  });
});
