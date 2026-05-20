import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import {
  SendTextValidationError,
  sendTextInternal,
} from "@/lib/messaging/send-text-internal";
import { sendInteractiveInternal } from "@/lib/messaging/send-interactive-internal";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import { type ContactLike, resolveFieldTokens } from "@ccp/shared/field-tokens";
import type { InteractiveOption } from "@ccp/shared/providers/types";

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

/**
 * Where to persist the contact's answer when one arrives. Only the custom
 * field path is wired today — admins create the field via /settings/contact-fields,
 * then point the step at the field's `key`. The answer is written verbatim
 * (truncated to the same JSONB-safe limit that the manual contact edit
 * applies) to `Contact.customFields[key]`.
 *
 * Phase B+ extensions could add { kind: "contact_column"; column: "email" |
 * "location" } to overwrite a built-in column, but free-text → known column
 * is risky (email/location need format validation we don't run here) so
 * gating that behind an explicit kind keeps the door open without
 * accidentally enabling it.
 */
export type AskQuestionSaveTo = { kind: "custom_field"; key: string };

/**
 * Answer shape the contact picks from:
 *
 *   free_text → any reply they send is the answer (existing behavior).
 *   buttons   → 1-3 quick-reply buttons via WhatsApp interactive message.
 *               The contact taps; the option id flows through as
 *               `$var.previousStep.optionId` for downstream routing.
 *   list      → 1-10 list rows. Same routing model as buttons; use this
 *               shape when buttons cap (3) isn't enough.
 *
 * Outside the 24h customer-service window, ALL interactive sends fail
 * (same Meta policy as free-form text). The step short-circuits to the
 * `timeout` edge so the author can wire a Send Template fallback there.
 */
export type AskQuestionAnswerKind = "free_text" | "buttons" | "list";

export interface AskQuestionStepConfig {
  question: string;
  timeoutHours: number;
  saveTo?: AskQuestionSaveTo;
  answerKind?: AskQuestionAnswerKind;
  options?: InteractiveOption[];
  listCtaLabel?: string;
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
    let saveTo: AskQuestionSaveTo | undefined;
    if (r.saveTo !== undefined && r.saveTo !== null) {
      if (typeof r.saveTo !== "object" || Array.isArray(r.saveTo)) {
        throw new StepConfigError("ask_question.saveTo must be an object");
      }
      const s = r.saveTo as Record<string, unknown>;
      if (s.kind !== "custom_field") {
        throw new StepConfigError(`ask_question.saveTo.kind "${String(s.kind)}" is not supported`);
      }
      if (typeof s.key !== "string" || !s.key.trim()) {
        throw new StepConfigError("ask_question.saveTo.key must be a non-empty string");
      }
      saveTo = { kind: "custom_field", key: s.key };
    }
    const answerKind: AskQuestionAnswerKind =
      r.answerKind === "buttons" || r.answerKind === "list" ? r.answerKind : "free_text";
    let options: InteractiveOption[] | undefined;
    if (answerKind !== "free_text") {
      if (!Array.isArray(r.options) || r.options.length === 0) {
        throw new StepConfigError(
          `ask_question.options must be a non-empty array when answerKind="${answerKind}"`,
        );
      }
      const maxOptions = answerKind === "buttons" ? 3 : 10;
      if (r.options.length > maxOptions) {
        throw new StepConfigError(
          `ask_question.options length ${r.options.length} exceeds the ${maxOptions}-option cap for answerKind="${answerKind}"`,
        );
      }
      const parsed: InteractiveOption[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < r.options.length; i++) {
        const opt = r.options[i] as Record<string, unknown>;
        if (!opt || typeof opt !== "object") {
          throw new StepConfigError(`ask_question.options[${i}] must be an object`);
        }
        if (typeof opt.id !== "string" || !opt.id.trim()) {
          throw new StepConfigError(`ask_question.options[${i}].id must be a non-empty string`);
        }
        if (typeof opt.title !== "string" || !opt.title.trim()) {
          throw new StepConfigError(`ask_question.options[${i}].title must be a non-empty string`);
        }
        if (seen.has(opt.id)) {
          throw new StepConfigError(`ask_question.options has duplicate id "${opt.id}"`);
        }
        seen.add(opt.id);
        parsed.push({
          id: opt.id,
          title: opt.title,
          ...(typeof opt.description === "string" && opt.description
            ? { description: opt.description }
            : {}),
        });
      }
      options = parsed;
    }
    const listCtaLabel =
      typeof r.listCtaLabel === "string" && r.listCtaLabel.trim()
        ? r.listCtaLabel
        : undefined;
    return {
      question: r.question,
      timeoutHours: hours,
      ...(saveTo ? { saveTo } : {}),
      ...(answerKind !== "free_text" ? { answerKind } : {}),
      ...(options ? { options } : {}),
      ...(listCtaLabel ? { listCtaLabel } : {}),
    };
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
      // Clean up the awaiting row regardless of source. The ingest hook
      // also deletes on the answered path, so this is idempotent there;
      // on the timeout path the row is still present and this is the
      // canonical cleanup. deleteMany over delete to avoid throwing on
      // an already-gone row.
      await db.workflowAwaitingReply.deleteMany({
        where: { runId: ctx.runId },
      });

      // Save-to-field: persist the answer onto the contact's customFields
      // bag when configured. Only fires on the answered path — a timeout
      // shouldn't overwrite the field with an empty value (or worse,
      // clobber an existing answer from a prior question).
      if (answered && config.saveTo && ctx.pendingAnswer) {
        const c = envelopeContact(envelope);
        const contactId = c?.id;
        if (contactId) {
          const trimmed = ctx.pendingAnswer.body.slice(0, 2048);
          // jsonb concatenation: existing keys are preserved, the target
          // key is overwritten. Same pattern as the manual contact-panel
          // edit flow (update-field step + contact PATCH).
          await db.contact.update({
            where: { id: contactId },
            data: {
              customFields: {
                ...((c.customFields ?? {}) as Record<string, string>),
                [config.saveTo.key]: trimmed,
              },
            },
          });
        }
      }
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
      if (config.answerKind === "buttons" || config.answerKind === "list") {
        // Interactive — buttons (1-3) or list (1-10). The contact's tap
        // round-trips as `interactiveReply.id` which the runner exposes
        // via `ctx.pendingAnswer.optionId` on resume.
        await sendInteractiveInternal({
          teamId: ctx.teamId,
          conversationId,
          bodyText: body,
          kind: config.answerKind,
          options: config.options ?? [],
          ...(config.listCtaLabel ? { listCtaLabel: config.listCtaLabel } : {}),
          sentVia: `workflow/${ctx.workflowId}`,
        });
      } else {
        await sendTextInternal({
          teamId: ctx.teamId,
          conversationId,
          body,
          sentVia: `workflow/${ctx.workflowId}`,
        });
      }
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
