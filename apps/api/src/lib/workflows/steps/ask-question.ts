import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import {
  SendTextValidationError,
  sendTextInternal,
} from "@/lib/messaging/send-text-internal";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import { type ContactLike, resolveFieldTokens } from "@ccp/shared/field-tokens";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advanceWithError,
  envelopeContact,
  envelopeExtras,
  truncateBody,
} from "./types";

/**
 * `ask_question` step. Sends a free-form question to the trigger contact,
 * pauses the run waiting for their next inbound message (or `timeoutHours`,
 * whichever comes first), then routes:
 *
 *   answered → contact replied within the timeout window
 *   timeout  → no reply by the deadline
 *
 *   Config: { question: string, timeoutHours: number }
 *
 * The answer is exposed downstream via `$var.previousStep.answer` so authors
 * can branch on the body with the existing `message_contains` Branch preset
 * (or write a custom-expression Branch).
 *
 * Lifecycle:
 *   First call (isResume=false) — `question` is rendered + sent, the run
 *   pauses (await_reply result). The runner writes a WorkflowAwaitingReply
 *   row keyed on runId.
 *
 *   Resume call (isResume=true) — the handler reads `pendingAnswer` from
 *   ctx. Set ⇒ branch "answered"; null ⇒ branch "timeout". The runner
 *   clears WorkflowAwaitingReply + pendingAnswer after this branch lands
 *   on the next step (delete handled by the inbound ingest hook; the
 *   timeout path leaves the row to be cleaned by the daily sweeper).
 *
 * Only fires on contact-scoped triggers — runner returns a permanent
 * failure if `run.contactId` is null when await_reply lands. The same is
 * true for the send: a workflow with no contact has no inbound channel.
 */

export interface AskQuestionStepConfig {
  question: string;
  timeoutHours: number;
}

const MIN_TIMEOUT_HOURS = 1;
// 7 days. WhatsApp's 24h window is the practical ceiling for FREE-FORM
// outbound, but the question itself can have been sent earlier and we're
// just waiting on the reply — so a longer wait is fine, capped at 7d to
// match other long-wait step ceilings.
const MAX_TIMEOUT_HOURS = 24 * 7;
const DEFAULT_TIMEOUT_HOURS = 24;

export const askQuestionStepHandler: StepHandler<AskQuestionStepConfig> = {
  type: "ask_question",
  sideEffect: "irreversible",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("ask_question config must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.question !== "string" || !r.question.trim()) {
      throw new StepConfigError("ask_question.question must be a non-empty string");
    }
    const rawHours =
      typeof r.timeoutHours === "number"
        ? r.timeoutHours
        : Number.parseInt(String(r.timeoutHours ?? ""), 10);
    const hours = Number.isFinite(rawHours) ? rawHours : DEFAULT_TIMEOUT_HOURS;
    if (hours < MIN_TIMEOUT_HOURS || hours > MAX_TIMEOUT_HOURS) {
      throw new StepConfigError(
        `ask_question.timeoutHours must be between ${MIN_TIMEOUT_HOURS} and ${MAX_TIMEOUT_HOURS}`,
      );
    }
    return { question: r.question, timeoutHours: hours };
  },
  describeConfig(config) {
    return `Ask "${config.question.slice(0, 40)}${config.question.length > 40 ? "…" : ""}"`;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    // Resume path: the contact replied (or the timer fired). The runner
    // populates ctx.pendingAnswer from the run row before calling us;
    // present ⇒ answered, null ⇒ timeout.
    if (ctx.isResume) {
      const answered = ctx.pendingAnswer !== null && ctx.pendingAnswer !== undefined;
      return {
        kind: "branch",
        status: 200,
        body: truncateBody(
          JSON.stringify({
            selected: answered ? "answered" : "timeout",
            answer: answered ? ctx.pendingAnswer?.body ?? null : null,
          }),
        ),
        selectedLabel: answered ? "answered" : "timeout",
      };
    }

    // First call: send the question, then pause.
    const c = envelopeContact(envelope);
    if (!c) {
      return advanceWithError(
        400,
        "ask_question requires a contact-scoped trigger",
      );
    }
    // Resolve the conversation off the envelope (same path as send_message
    // for trigger_contact). If the trigger doesn't carry a conversation, we
    // can't send WhatsApp — bail. Workflows triggered on contact-only
    // events (contact_tag_updated, etc.) can't host an ask_question.
    const data = envelope.data as { conversation?: { id?: string } | null };
    const conversationId = data.conversation?.id;
    if (!conversationId) {
      return advanceWithError(
        400,
        "ask_question requires a conversation (use a message-scoped trigger)",
      );
    }

    // Resolve the contact row for $var token expansion. Same shape as the
    // send_message handler's trigger-contact path.
    const contact: ContactLike = {
      name: c.name ?? "",
      phoneNumber: c.phoneNumber ?? null,
      email: c.email ?? null,
      location: null,
      customFields: c.customFields ?? {},
    };
    const body = resolveFieldTokens(config.question, contact, envelopeExtras(envelope));

    try {
      await sendTextInternal({
        teamId: ctx.teamId,
        conversationId,
        body,
        sentVia: `workflow/${ctx.workflowId}`,
      });
    } catch (err) {
      if (err instanceof SendTextValidationError) {
        // Closed window etc. — fall through to the timeout edge so the
        // workflow author can wire a fallback (send_template, etc.).
        return {
          kind: "branch",
          status: 422,
          body: truncateBody(
            JSON.stringify({ selected: "timeout", error: err.code, detail: err.detail }),
          ),
          selectedLabel: "timeout",
        };
      }
      const normalized = normalizeMetaSendError(err);
      if (normalized) {
        return {
          kind: "branch",
          status: 422,
          body: truncateBody(
            JSON.stringify({ selected: "timeout", error: normalized.code, message: normalized.message }),
          ),
          selectedLabel: "timeout",
        };
      }
      throw err;
    }

    // Defense-in-depth: clear any pendingAnswer from a previous question
    // before pausing. The runner also clears it inside the await_reply
    // transaction, but writing once here keeps the read-modify-write
    // narrow if the runner's order ever changes.
    await db.workflowRun.update({
      where: { id: ctx.runId },
      data: { pendingAnswer: Prisma.DbNull },
    });

    return {
      kind: "await_reply",
      status: 200,
      body: truncateBody(JSON.stringify({ question: body, timeoutHours: config.timeoutHours })),
      timeoutMs: config.timeoutHours * 60 * 60 * 1000,
    };
  },
};
