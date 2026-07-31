import {
  CONVERSION_EVENT_NAMES,
  type ConversionEventName,
} from "@ccp/shared/workflow-shapes";

import { contactAcquisition } from "@/lib/analytics/acquisition-sources";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import { getInstagramSendConfig } from "@/lib/providers/instagram-config";
import {
  buildConversionsEventBody,
  conversionsPermissionHint,
  conversionsUserData,
  isConversionsChannel,
  postConversionsEvent,
  resolveConversionsDatasetId,
} from "@/lib/providers/meta-conversions";
import { getMessengerSendConfig } from "@/lib/providers/messenger-config";
import { MetaSendError } from "@/lib/providers/meta-send-error";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advance,
  advanceWithError,
  envelopeContact,
  envelopeConversation,
} from "./types";

/**
 * `send_conversions_event` step — reports a conversion (Purchase, QualifiedLead,
 * …) back to Meta Ads for the ad this contact came from, via the Conversions
 * API for business messaging (`action_source: "business_messaging"`).
 * WhatsApp / Messenger signals power purchase optimization on CTWA /
 * click-to-Messenger campaigns; Instagram is measurement-only for now (Meta:
 * "not available for Instagram ad optimization at this time") but the event is
 * still sent so the account measures.
 *
 * Idempotency posture: the POST is a billed-adjacent, externally-visible side
 * effect and Meta does NOT dedupe business-messaging events (`event_id` is
 * accepted but explicitly not used for dedup) — so OUR side is the dedup:
 * `sideEffect: "irreversible"` makes the runner journal `in_progress` before
 * running, and a crash-redelivery advances (`skipped_after_crash`) instead of
 * re-sending. A clean pre-POST failure (config missing, 4xx from Graph) writes
 * a terminal entry, so a BullMQ retry after a thrown transient error re-runs
 * normally. We still stamp `event_id` (runId:stepId:executionIndex — the
 * executionIndex fold is REQUIRED by StepRunContext's contract so a
 * jump_to_step loop iteration is a distinct event) as a harmless belt.
 *
 * Loop safety: leaf side effect — publishes no domain events, triggers nothing.
 *
 * Missing prerequisites are SKIPS, not failures: a contact who arrived
 * organically (no `ctwa_clid`) is the normal case on a mixed audience, and the
 * run should carry on. Only transient transport / 5xx errors throw (BullMQ
 * retries with backoff, guarded by the journal above).
 */

export interface SendConversionsEventStepConfig {
  eventName: ConversionEventName;
  /** ISO-4217, e.g. "USD". Required iff `value` is set. */
  currency?: string;
  value?: number;
  /**
   * Events Manager "Test Events" routing code. A plumbing check, NOT a
   * sandbox — Meta still uses these events for delivery ("not dropped").
   */
  testEventCode?: string;
}

export const sendConversionsEventStepHandler: StepHandler<SendConversionsEventStepConfig> = {
  type: "send_conversions_event",
  sideEffect: "irreversible",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("send_conversions_event config must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (
      typeof r.eventName !== "string" ||
      !(CONVERSION_EVENT_NAMES as readonly string[]).includes(r.eventName)
    ) {
      throw new StepConfigError(
        `send_conversions_event.eventName must be one of: ${CONVERSION_EVENT_NAMES.join(", ")}`,
      );
    }
    const cfg: SendConversionsEventStepConfig = {
      eventName: r.eventName as ConversionEventName,
    };
    const hasValue = r.value !== undefined && r.value !== null && r.value !== "";
    const hasCurrency = typeof r.currency === "string" && r.currency.trim().length > 0;
    if (hasValue) {
      const n = typeof r.value === "number" ? r.value : Number(r.value);
      if (!Number.isFinite(n) || n < 0) {
        throw new StepConfigError("send_conversions_event.value must be a non-negative number");
      }
      cfg.value = n;
    }
    if (hasCurrency) {
      const c = (r.currency as string).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(c)) {
        throw new StepConfigError(
          'send_conversions_event.currency must be a 3-letter ISO code (e.g. "USD")',
        );
      }
      cfg.currency = c;
    }
    // Meta's custom_data pairs them; half a pair would be silently meaningless.
    if (hasValue !== hasCurrency) {
      throw new StepConfigError(
        "send_conversions_event: set currency and value together, or neither",
      );
    }
    if (typeof r.testEventCode === "string" && r.testEventCode.trim().length > 0) {
      cfg.testEventCode = r.testEventCode.trim();
    }
    return cfg;
  },
  describeConfig(c) {
    return `Send ${c.eventName} conversion to Meta Ads`;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    const conversation = envelopeConversation(envelope);
    const contact = envelopeContact(envelope);
    if (!conversation || !contact) {
      return advanceWithError(
        400,
        "send_conversions_event needs a conversation-scoped trigger",
      );
    }
    const channel = conversation.channel;
    if (!isConversionsChannel(channel)) {
      // Not an error the author can fix per-run (the widget has no ad loop) —
      // record why and let the flow carry on.
      return advance({ skipped: "unsupported_channel", channel });
    }
    const accountId = conversation.channelConnectionId ?? null;

    // Resolve the channel identity + credentials. Config problems (including
    // account-unresolved on a multi-account workspace) advance-with-error:
    // retrying won't reconnect a channel.
    let host: {
      hostId: string;
      accessToken: string;
      graphVersion: string;
      appSecret?: string;
      userData: Record<string, string>;
    };
    try {
      if (channel === "whatsapp") {
        const cfg = await getMetaSendConfig(ctx.workspaceId, accountId);
        if (!cfg.wabaId) {
          return advanceWithError(
            422,
            "waba_unknown",
            "This number has no WhatsApp Business Account linked, so it has no conversions dataset.",
          );
        }
        // The contact's FIRST attributed inbound — same lookup that powers
        // /v1/contacts/:id/acquisition, so the step and the profile can never
        // disagree about which click gets the credit. `clickId` is WhatsApp's
        // ctwa_clid, sent RAW (never hashed).
        const acquisition = await contactAcquisition(ctx.workspaceId, contact.id);
        const clid = typeof acquisition?.clickId === "string" ? acquisition.clickId : "";
        if (!clid) {
          return advance({ skipped: "no_ad_click_id", detail: "no ad click id on this contact" });
        }
        host = {
          hostId: cfg.wabaId,
          accessToken: cfg.accessToken,
          graphVersion: cfg.graphVersion,
          ...(cfg.appSecret ? { appSecret: cfg.appSecret } : {}),
          userData: conversionsUserData({ channel, wabaId: cfg.wabaId, ctwaClid: clid }),
        };
      } else if (channel === "messenger") {
        const cfg = await getMessengerSendConfig(ctx.workspaceId, accountId);
        const psid = contact.externalContactId ?? "";
        if (!psid) return advance({ skipped: "no_channel_user_id" });
        host = {
          hostId: cfg.pageId,
          accessToken: cfg.pageAccessToken,
          graphVersion: cfg.graphVersion,
          ...(cfg.appSecret ? { appSecret: cfg.appSecret } : {}),
          userData: conversionsUserData({ channel, pageId: cfg.pageId, psid }),
        };
      } else {
        const cfg = await getInstagramSendConfig(ctx.workspaceId, accountId);
        const igsid = contact.externalContactId ?? "";
        if (!igsid) return advance({ skipped: "no_channel_user_id" });
        host = {
          // The dataset hangs off the IG professional account, not the linked
          // Page (unlike sends) — `POST /{IG_USER_ID}/dataset`.
          hostId: cfg.igId,
          accessToken: cfg.igAccessToken,
          graphVersion: cfg.graphVersion,
          ...(cfg.appSecret ? { appSecret: cfg.appSecret } : {}),
          userData: conversionsUserData({ channel, igId: cfg.igId, igsid }),
        };
      }
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        return advanceWithError(422, "channel_not_configured", err.message);
      }
      throw err;
    }

    const eventId = `${ctx.runId}:${ctx.stepId}:${ctx.executionIndex}`;
    try {
      const datasetId = await resolveConversionsDatasetId({
        workspaceId: ctx.workspaceId,
        channel,
        connectionId: accountId,
        hostId: host.hostId,
        accessToken: host.accessToken,
        graphVersion: host.graphVersion,
        appSecret: host.appSecret,
      });
      const body = buildConversionsEventBody({
        channel,
        eventName: config.eventName,
        // Unix seconds, stamped NOW — Meta rejects events older than 7 days,
        // so the send time is the event time.
        eventTime: Math.floor(Date.now() / 1000),
        eventId,
        userData: host.userData,
        ...(config.value !== undefined
          ? { value: config.value, currency: config.currency }
          : {}),
        ...(config.testEventCode ? { testEventCode: config.testEventCode } : {}),
      });
      await postConversionsEvent({
        datasetId,
        body,
        accessToken: host.accessToken,
        graphVersion: host.graphVersion,
        appSecret: host.appSecret,
      });
      return advance({ datasetId, eventName: config.eventName, eventId });
    } catch (err) {
      // A Graph 4xx is a standing fact (most commonly a missing permission on
      // a BYO app) — retrying cannot fix it, so surface the actionable grant
      // and advance. 5xx / network / timeout falls through to the throw so
      // BullMQ retries with backoff (journal-guarded, see file header).
      if (err instanceof MetaSendError && err.httpStatus < 500) {
        return advanceWithError(
          422,
          "meta_conversions_rejected",
          `Meta rejected the conversion event — ${conversionsPermissionHint(channel)}. ${err.body.slice(0, 300)}`,
        );
      }
      throw err;
    }
  },
};
