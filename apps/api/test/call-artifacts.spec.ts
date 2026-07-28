/**
 * Calling artifacts + conformance regressions (calling doc series, 2026-07-28).
 *
 * Pure parser/schema tests — no DB. Each block pins a behavior that was
 * either a fixed defect or a doc-grounded contract:
 *
 *   - `call_recording_available` / `call_transcription_available` parse into
 *     artifact events carrying the durable media id (NOT the 5-minute url).
 *   - The business-initiated connect answer is read from
 *     `connection.webrtc.sdp` when `session` is absent (the doc's Part-3
 *     sample carries both; losing the fallback strands the call in silence).
 *   - Terminate status matching is case-insensitive ("Completed" vs
 *     COMPLETED — the doc itself shows both) and answered/missed is decided
 *     by timing presence, not the status string.
 *   - A restriction webhook listing BOTH directions stamps the
 *     BUSINESS_INITIATED entry (its window gates OUR outbound calls).
 *   - `USER_INITIATED_CALLS_LOW_PICKUP_RATE` (says CALLS, not CALLING) lands
 *     in callingQualityWarning, not the policy-violation slot.
 *   - `account_settings_update` is a known, quiet drop.
 *   - The call-hours / voicemail / recording-policy schemas enforce Meta's
 *     documented rules as field errors, and Arabic TEXT is accepted wherever
 *     the content is ours (purpose, consent message).
 *
 *   pnpm --filter @ccp/api exec vitest run test/call-artifacts.spec.ts
 */
import { existsSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

import { metaProvider } from "@/lib/providers/meta";
import {
  ConsentMessageSchema,
  RecordingPolicySchema,
  UpdateCallSettingsSchema,
} from "@/calls/calls.schemas";
import type {
  NormalizedCallEvent,
  NormalizedChannelHealth,
} from "@ccp/shared/providers/types";

const WABA = "366634483210360";
const PHONE_ID = "436666719526789";

function callsEnvelope(call: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: "calls",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                phone_number_id: PHONE_ID,
                display_phone_number: "13175551399",
              },
              calls: [call],
            },
          },
        ],
      },
    ],
  };
}

function accountUpdateEnvelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: WABA,
        changes: [{ field: "account_update", value }],
      },
    ],
  };
}

function callEvents(payload: unknown): NormalizedCallEvent[] {
  return metaProvider
    .parseWebhook(payload)
    .filter((e): e is NormalizedCallEvent => e.kind === "call");
}

describe("recording/transcript artifact webhooks", () => {
  it("parses call_recording_available into a recording_available event with the durable media id", () => {
    const events = callEvents(
      callsEnvelope({
        id: "wacid.REC1",
        from: "14085551234",
        timestamp: "1728932177",
        event: "call_recording_available",
        call_recording: {
          type: "audio",
          audio: {
            id: "1002764438271669",
            sha256: "Y9vvGyeo3n76ptkXu3CwDBsnzbRFqpjHskQdMGSVqas=",
            mime_type: "audio/ogg; codecs=opus",
            url: "https://lookaside.example/expires-in-5-minutes",
          },
        },
      }),
    );
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.phase).toBe("recording_available");
    expect(evt.externalCallId).toBe("wacid.REC1");
    expect(evt.recordingMedia).toEqual({
      mediaId: "1002764438271669",
      mimeType: "audio/ogg; codecs=opus",
      sha256: "Y9vvGyeo3n76ptkXu3CwDBsnzbRFqpjHskQdMGSVqas=",
    });
  });

  // BOTH event names: the call-transcription doc says
  // `call_transcription_available`, but the wire delivers
  // `call_transcript_available` (observed live 2026-07-28 — the documented
  // name never arrived and the transcript was silently dropped). Accepting
  // only the doc name is the regression this pins against.
  for (const eventName of [
    "call_transcription_available",
    "call_transcript_available",
  ]) {
    it(`parses ${eventName} into a transcript_available event`, () => {
      const events = callEvents(
        callsEnvelope({
          id: "wacid.TR1",
          from: "14085551234",
          timestamp: "1728932177",
          event: eventName,
          call_transcript: {
            document: {
              id: "555000111",
              sha256: "abc=",
              mime_type: "application/json",
              url: "https://lookaside.example/short-lived",
            },
          },
        }),
      );
      expect(events).toHaveLength(1);
      const evt = events[0]!;
      expect(evt.phase).toBe("transcript_available");
      expect(evt.transcriptMedia).toEqual({
        mediaId: "555000111",
        mimeType: "application/json",
        sha256: "abc=",
      });
    });
  }
});

describe("business-initiated connect SDP fallback", () => {
  it("reads the answer from connection.webrtc.sdp when session is absent, rewriting actpass", () => {
    const events = callEvents(
      callsEnvelope({
        id: "wacid.BIC1",
        to: "12185552828",
        from: "13175551399",
        event: "connect",
        timestamp: "1749196895",
        direction: "BUSINESS_INITIATED",
        connection: {
          webrtc: { sdp: "v=0\r\na=setup:actpass\r\n" },
        },
      }),
    );
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.phase).toBe("connecting");
    expect(evt.sdp?.type).toBe("answer");
    // The browser rejects answer SDPs carrying actpass — the fallback path
    // must apply the same actpass→passive rewrite the session path does,
    // INCLUDING on RFC 8866 \r\n line endings (a bare `$` anchor misses the
    // \r and silently no-ops — the exact bug this assertion caught).
    expect(evt.sdp?.sdp).toContain("a=setup:passive\r\n");
    expect(evt.sdp?.sdp).not.toContain("actpass");
  });
});

describe("terminate status semantics", () => {
  it('treats mixed-case "Completed" WITH timing as completed', () => {
    const events = callEvents(
      callsEnvelope({
        id: "wacid.T1",
        to: "12185552828",
        from: "13175551399",
        event: "terminate",
        direction: "USER_INITIATED",
        timestamp: "1749197480",
        status: "Completed",
        start_time: "1671644824",
        end_time: "1671644944",
        duration: 120,
      }),
    );
    expect(events[0]!.phase).toBe("completed");
    expect(events[0]!.durationSeconds).toBe(120);
  });

  it("carries the failure reason from terminate errors[] (calling errors label via `message`)", () => {
    const payload = callsEnvelope({
      id: "wacid.T3",
      to: "12185552828",
      from: "13175551399",
      event: "terminate",
      direction: "BUSINESS_INITIATED",
      timestamp: "1749197480",
      status: "FAILED",
    });
    // Terminate errors sit at VALUE level alongside calls[] (troubleshooting
    // doc: "the only place Meta says WHY a call failed"). Calling errors use
    // `message` for the label where message-status errors use `title`.
    (
      payload.entry[0]!.changes[0]!.value as Record<string, unknown>
    ).errors = [
      {
        code: 138021,
        message: "Media receive timeout",
        error_data: { details: "No media received from business for 30s" },
      },
    ];
    const events = callEvents(payload);
    expect(events).toHaveLength(1);
    expect(events[0]!.phase).toBe("failed");
    expect(events[0]!.errorCode).toBe(138021);
    expect(events[0]!.errorTitle).toBe("Media receive timeout");
    expect(events[0]!.errorDetail).toBe("No media received from business for 30s");
  });

  it("treats COMPLETED WITHOUT timing as missed (nobody picked up)", () => {
    const events = callEvents(
      callsEnvelope({
        id: "wacid.T2",
        to: "12185552828",
        from: "13175551399",
        event: "terminate",
        direction: "BUSINESS_INITIATED",
        timestamp: "1749197480",
        status: "COMPLETED",
      }),
    );
    expect(events[0]!.phase).toBe("missed");
  });
});

describe("restriction/violation direction handling", () => {
  function healthEvents(payload: unknown): NormalizedChannelHealth[] {
    return metaProvider
      .parseWebhook(payload)
      .filter(
        (e): e is NormalizedChannelHealth => e.kind === "channel_health",
      );
  }

  it("prefers the BUSINESS_INITIATED restriction when both directions are listed", () => {
    const events = healthEvents(
      accountUpdateEnvelope({
        phone_number: "13175551399",
        event: "ACCOUNT_RESTRICTION",
        restriction_info: [
          {
            restriction_type: "RESTRICTED_USER_INITIATED_CALLING",
            expiration: 1900000000,
          },
          {
            restriction_type: "RESTRICTED_BUSINESS_INITIATED_CALLING",
            expiration: 1900000500,
          },
        ],
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.callingRestrictionType).toBe(
      "RESTRICTED_BUSINESS_INITIATED_CALLING",
    );
    expect(events[0]!.callingRestrictedUntil?.getTime()).toBe(1900000500 * 1000);
  });

  it("files USER_INITIATED_CALLS_LOW_PICKUP_RATE as a calling quality warning", () => {
    const events = healthEvents(
      accountUpdateEnvelope({
        phone_number: "16505552771",
        event: "ACCOUNT_VIOLATION",
        violation_info: {
          violation_type: "USER_INITIATED_CALLS_LOW_PICKUP_RATE",
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.callingQualityWarning).toBe(
      "USER_INITIATED_CALLS_LOW_PICKUP_RATE",
    );
    expect(events[0]!.policyViolationType).toBeUndefined();
  });
});

describe("account_settings_update", () => {
  it("drops the field quietly — no unhandled-field warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const events = metaProvider.parseWebhook({
        object: "whatsapp_business_account",
        entry: [
          {
            id: WABA,
            changes: [
              {
                field: "account_settings_update",
                value: {
                  messaging_product: "whatsapp",
                  type: "PHONE_NUMBER_SETTINGS",
                  phone_number_settings: {
                    phone_number_id: PHONE_ID,
                    calling: { status: "ENABLED" },
                  },
                },
              },
            ],
          },
        ],
      });
      expect(events).toHaveLength(0);
      const unhandled = warn.mock.calls.filter((args) =>
        String(args[0]).includes("unhandled_field"),
      );
      expect(unhandled).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("call-hours schema pre-flight", () => {
  const base = { timezoneId: "Asia/Riyadh" };
  const parse = (windows: unknown[]) =>
    UpdateCallSettingsSchema.safeParse({ hours: { ...base, windows } });

  it("accepts a valid lunch-break pair", () => {
    expect(
      parse([
        { dayOfWeek: "MONDAY", openTime: "0900", closeTime: "1300" },
        { dayOfWeek: "MONDAY", openTime: "1400", closeTime: "1800" },
      ]).success,
    ).toBe(true);
  });

  it("rejects openTime >= closeTime", () => {
    expect(
      parse([{ dayOfWeek: "MONDAY", openTime: "1800", closeTime: "0900" }])
        .success,
    ).toBe(false);
  });

  it("rejects a third window on one day", () => {
    expect(
      parse([
        { dayOfWeek: "MONDAY", openTime: "0800", closeTime: "0900" },
        { dayOfWeek: "MONDAY", openTime: "1000", closeTime: "1100" },
        { dayOfWeek: "MONDAY", openTime: "1200", closeTime: "1300" },
      ]).success,
    ).toBe(false);
  });

  it("rejects overlapping windows on one day", () => {
    expect(
      parse([
        { dayOfWeek: "MONDAY", openTime: "0900", closeTime: "1300" },
        { dayOfWeek: "MONDAY", openTime: "1200", closeTime: "1800" },
      ]).success,
    ).toBe(false);
  });
});

describe("voicemail schema pre-flight", () => {
  const parse = (voicemail: unknown) =>
    UpdateCallSettingsSchema.safeParse({ voicemail });

  it("rejects enabled voicemail without triggers or announcement", () => {
    expect(parse({ enabled: true }).success).toBe(false);
  });

  it("rejects the TIMEOUT trigger without timeoutSeconds (Meta silently disables it)", () => {
    expect(
      parse({
        enabled: true,
        triggers: ["TIMEOUT"],
        announcementMediaId: "123",
      }).success,
    ).toBe(false);
  });

  it("accepts a complete enabled config and a bare disable", () => {
    expect(
      parse({
        enabled: true,
        triggers: ["REJECT", "TIMEOUT"],
        announcementMediaId: "123",
        timeoutSeconds: 20,
      }).success,
    ).toBe(true);
    expect(parse({ enabled: false }).success).toBe(true);
  });
});

describe("recording policy + consent message schemas", () => {
  it("requires purpose and announcement language when enabled", () => {
    expect(RecordingPolicySchema.safeParse({ enabled: true }).success).toBe(
      false,
    );
    expect(
      RecordingPolicySchema.safeParse({
        enabled: true,
        purpose: "quality assurance",
      }).success,
    ).toBe(false);
  });

  it("rejects Arabic as an ANNOUNCEMENT language (no provider voice) but accepts Arabic purpose TEXT", () => {
    expect(
      RecordingPolicySchema.safeParse({
        enabled: true,
        purpose: "quality assurance",
        announcementLanguage: "ar",
      }).success,
    ).toBe(false);
    const arabicPurpose = RecordingPolicySchema.safeParse({
      enabled: true,
      purpose: "ضمان الجودة وتحسين الخدمة",
      announcementLanguage: "en",
    });
    expect(arabicPurpose.success).toBe(true);
  });

  it("accepts an Arabic consent message and a null clear", () => {
    expect(
      ConsentMessageSchema.safeParse({
        message: "سيتم تسجيل هذه المكالمة لأغراض الجودة وتحسين الخدمة.",
      }).success,
    ).toBe(true);
    expect(ConsentMessageSchema.safeParse({ message: null }).success).toBe(true);
  });
});
