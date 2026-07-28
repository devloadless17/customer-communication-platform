import { z } from "zod";

import { RECORDING_ANNOUNCEMENT_LANGUAGES } from "@ccp/shared/providers/types";

/**
 * Request body schemas for the WhatsApp calling endpoints. Validation lives
 * here so the controller stays declarative — zBody(...) at the route, then
 * the typed input flows into the service.
 */

/**
 * Outbound-call initiation body.
 *
 * `sdp` is the WebRTC OFFER the agent's browser generated via
 * `RTCPeerConnection.createOffer` — Meta's calling API requires it on the
 * connect payload (otherwise error 131009 "Missing session parameter").
 * Same upper bound as the answer SDP — well above any real SDP size
 * (~3-5KB typical).
 */
export const InitiateCallSchema = z
  .object({
    sdp: z.string().min(1).max(64_000),
  })
  .strict();
export type InitiateCallInput = z.infer<typeof InitiateCallSchema>;

/** Permission request — no body. */
export const RequestCallPermissionSchema = z.object({}).strict();
export type RequestCallPermissionInput = z.infer<typeof RequestCallPermissionSchema>;

/**
 * Answer body — the SDP the browser generated via RTCPeerConnection.createAnswer.
 * Bounded length so a malformed POST can't pin the gateway with a huge SDP.
 */
export const AnswerCallSchema = z
  .object({
    sdp: z.string().min(1).max(64_000),
  })
  .strict();
export type AnswerCallInput = z.infer<typeof AnswerCallSchema>;

/**
 * Media-update body — the SDP ANSWER the browser generated in reply to Meta's
 * mid-call renegotiation OFFER (Messenger `media_update`). Same bounded shape
 * as the answer body.
 */
export const MediaUpdateSchema = z
  .object({
    sdp: z.string().min(1).max(64_000),
  })
  .strict();
export type MediaUpdateInput = z.infer<typeof MediaUpdateSchema>;

/**
 * Reject body — an optional reason recorded LOCALLY only. The provider's reject
 * action accepts nothing but the call id, so this never goes on the wire.
 */
export const RejectCallSchema = z
  .object({
    reason: z.enum(["busy", "declined"]).optional(),
  })
  .strict();
export type RejectCallInput = z.infer<typeof RejectCallSchema>;

/** A single day's calling window. Times are 24h "HHMM" in the chosen timezone. */
const CallHoursWindowSchema = z
  .object({
    dayOfWeek: z.enum([
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY",
      "SUNDAY",
    ]),
    openTime: z.string().regex(/^([01]\d|2[0-3])[0-5]\d$/, "expected HHMM"),
    closeTime: z.string().regex(/^([01]\d|2[0-3])[0-5]\d$/, "expected HHMM"),
  })
  .strict();

/**
 * Calling-settings PATCH. Every field optional so a partial update can't reset
 * settings the admin didn't touch.
 *
 * An empty `hours.windows` means "reachable 24/7" — do not model that as a
 * 0000-2359 window, which would leave calls refused for the last minute of
 * every day.
 */
export const UpdateCallSettingsSchema = z
  .object({
    channel: z.string().optional(),
    enabled: z.boolean().optional(),
    callIconVisible: z.boolean().optional(),
    callbackPermissionEnabled: z.boolean().optional(),
    /** Countries whose customers see the call icon (ISO alpha-2, matched on
     *  the customer's phone country code). `[]` clears the restriction —
     *  meaningfully different from omitting the field, which leaves it. */
    callIconCountries: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z]{2}$/, "expected an ISO alpha-2 country code")
          .transform((c) => c.toUpperCase()),
      )
      .max(100)
      .optional(),
    /** Voicemail for missed/rejected inbound calls. Meta's own rules,
     *  pre-flighted here for a field error instead of a Graph rejection:
     *  enabling needs ≥1 trigger + an announcement; a TIMEOUT trigger needs
     *  timeoutSeconds (0–30) or the provider silently disables it. */
    voicemail: z
      .object({
        enabled: z.boolean(),
        triggers: z.array(z.enum(["REJECT", "TIMEOUT"])).max(2).optional(),
        announcementMediaId: z.string().min(1).max(64).optional(),
        timeoutSeconds: z.number().int().min(0).max(30).optional(),
      })
      .strict()
      .superRefine((vm, ctx) => {
        if (!vm.enabled) return;
        if (!vm.triggers?.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["triggers"],
            message: "voicemail needs at least one trigger when enabled",
          });
        }
        if (!vm.announcementMediaId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["announcementMediaId"],
            message: "voicemail needs an announcement recording when enabled",
          });
        }
        if (vm.triggers?.includes("TIMEOUT") && vm.timeoutSeconds === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["timeoutSeconds"],
            message: "the TIMEOUT trigger needs timeoutSeconds (0–30)",
          });
        }
      })
      .optional(),
    hours: z
      .object({
        timezoneId: z.string().min(1).max(64),
        // Up to two windows per day (e.g. a lunch break) across seven days.
        windows: z.array(CallHoursWindowSchema).max(14),
      })
      .strict()
      // Meta's own call_hours rules, checked here so the admin gets a field
      // error instead of a cryptic Graph rejection: open before close, at most
      // two windows per day, no overlap within a day.
      .superRefine((hours, ctx) => {
        const byDay = new Map<string, { open: number; close: number }[]>();
        for (const [i, w] of hours.windows.entries()) {
          const open = Number(w.openTime);
          const close = Number(w.closeTime);
          if (open >= close) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["windows", i],
              message: "openTime must be before closeTime",
            });
          }
          const list = byDay.get(w.dayOfWeek) ?? [];
          list.push({ open, close });
          byDay.set(w.dayOfWeek, list);
        }
        for (const [day, list] of byDay) {
          if (list.length > 2) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["windows"],
              message: `${day}: at most two windows per day`,
            });
            continue;
          }
          const [x, y] = list;
          if (x && y) {
            const [a, b] = x.open <= y.open ? [x, y] : [y, x];
            if (b.open < a.close) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["windows"],
                message: `${day}: windows overlap`,
              });
            }
          }
        }
      })
      .optional(),
  })
  .strict();
export type UpdateCallSettingsInput = z.infer<typeof UpdateCallSettingsSchema>;

/** End body — no fields. */
export const EndCallSchema = z.object({}).strict();
export type EndCallInput = z.infer<typeof EndCallSchema>;

/**
 * The number's standing recording policy. `announcementLanguage` is validated
 * against the provider's OWN supported locales (RECORDING_ANNOUNCEMENT_LANGUAGES
 * — notably WITHOUT Arabic as of 2026-07): an unsupported code fails the whole
 * call request at the provider, so it must never be storable here.
 */
export const RecordingPolicySchema = z
  .object({
    enabled: z.boolean(),
    /** Spoken to both parties after the fixed consent phrase. Provider cap. */
    purpose: z.string().trim().min(1).max(250).optional(),
    announcementLanguage: z
      .enum(
        RECORDING_ANNOUNCEMENT_LANGUAGES.map((l) => l.code) as [
          string,
          ...string[],
        ],
      )
      .optional(),
    /** The number's artifact mode, sent by the UI so the announcement fields
     *  are only required when they'll actually be used ("meta" mode). Not
     *  stored from here — the mode has its own endpoint. */
    mode: z.enum(["meta", "inapp"]).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    // In-app mode plays no announcement, so purpose/language are moot.
    if (!p.enabled || p.mode === "inapp") return;
    if (!p.purpose) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["purpose"],
        message: "a recording purpose is required when recording is enabled",
      });
    }
    if (!p.announcementLanguage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["announcementLanguage"],
        message: "an announcement language is required when recording is enabled",
      });
    }
  });
export type RecordingPolicyInput = z.infer<typeof RecordingPolicySchema>;

/**
 * The written consent notice auto-sent around recorded/transcribed calls.
 * Fully Arabic-capable (it's OUR message, not the provider's announcement
 * voice). Null or empty clears it.
 */
export const ConsentMessageSchema = z
  .object({
    message: z.string().trim().max(1000).nullable(),
  })
  .strict();
export type ConsentMessageInput = z.infer<typeof ConsentMessageSchema>;

/**
 * How the number produces call artifacts: the provider's built-in features
 * ("meta" — spoken announcement, ~1min delivery) or in-app ("inapp" — the
 * agent's browser records silently, transcripts via our own Whisper pipeline,
 * consent via the written notice).
 */
export const ArtifactModeSchema = z
  .object({
    mode: z.enum(["meta", "inapp"]),
  })
  .strict();
export type ArtifactModeInput = z.infer<typeof ArtifactModeSchema>;

/** Listing — keyset cursor on (ringingAt DESC, id DESC). */
export const ListCallsQuerySchema = z
  .object({
    take: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
  })
  .strict();
export type ListCallsQuery = z.infer<typeof ListCallsQuerySchema>;

/**
 * Team-wide Calls-page listing — keyset cursor PLUS optional filters:
 *   q    — substring match on the contact's name OR phone number
 *   from — only calls with ringingAt >= this instant (ISO; the client sends the
 *          start of the selected local day so the date range respects the
 *          agent's timezone)
 *   to   — only calls with ringingAt <= this instant (ISO; end of local day)
 * Filters compose with the cursor (AND), so pagination walks the filtered set.
 */
export const ListTeamCallsQuerySchema = z
  .object({
    take: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
    /** 1-based page for numbered pagination. When present the query runs in
     *  offset mode (cursor ignored, totalCount returned). Upper-bounded for
     *  the same reason as the contacts list: offset paging scans and discards
     *  everything before the offset, so an unbounded page number lets a client
     *  ask for a full scan that returns nothing. */
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    q: z.string().trim().max(100).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();
export type ListTeamCallsQuery = z.infer<typeof ListTeamCallsQuerySchema>;
