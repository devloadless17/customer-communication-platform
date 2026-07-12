import { normalizeStringMap } from "@/lib/normalize-string-map";
import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import {
  SendTextValidationError,
  sendTextInternal,
} from "@/lib/messaging/send-text-internal";
import { sendInteractiveInternal } from "@/lib/messaging/send-interactive-internal";
import {
  ConversationSendRateLimitedError,
  consumeConversationSendBudget,
} from "@/lib/messaging/conversation-send-budget";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import { toContactWire } from "@/lib/queries/_shared";
import { workflowContactSnapshot } from "@/lib/workflows/events";
import { resolveFieldTokens } from "@ccp/shared/field-tokens";
import type { Contact } from "@ccp/shared/types";
import type { ContactShareField, InteractiveOption } from "@ccp/shared/providers/types";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advanceWithError,
  envelopeContact,
  truncateBody,
} from "./types";
import { buildTokenContext } from "./token-context";

/**
 * Parse a free-text numeric answer without corrupting decimal-comma or
 * thousands-grouped replies. A blind `replace(/,/g, "")` turned "3,5" (→ 3.5 in
 * comma-decimal locales) into 35 and mis-validated ranges.
 *
 * Deterministic, locale-heuristic (no locale detection needed):
 *   - has a "." → "." is the decimal sep, "," is thousands grouping → drop ","
 *     ("1,234.56" → 1234.56).
 *   - no "." + exactly one "," with 1–2 trailing digits → decimal comma
 *     ("3,5" → 3.5, "1234,56" → 1234.56).
 *   - otherwise (multiple commas, or a 3-digit group like "1,000") → thousands
 *     grouping → drop "," ("1,000" → 1000, "12,345,678" → 12345678).
 * Returns NaN for unparseable input; the caller routes NaN to the clarifier.
 */
function parseAnswerNumber(body: string): number {
  const s = body.trim();
  let normalized: string;
  if (s.includes(".")) {
    normalized = s.replace(/,/g, "");
  } else if ((s.match(/,/g) ?? []).length === 1 && /,\d{1,2}$/.test(s)) {
    normalized = s.replace(",", ".");
  } else {
    normalized = s.replace(/,/g, "");
  }
  return Number.parseFloat(normalized);
}

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
/**
 * Adds `number` + `date` to the buttons/list/free_text set. These don't
 * change the WhatsApp send shape (still sent as plain text question), but
 * the resume path PARSES + VALIDATES the answer and routes a malformed
 * reply to the timeout edge. Authors can also set `numberMin`/`numberMax`
 * to enforce a range; out-of-range replies route to the validation edge
 * (treated as timeout for now — adding a dedicated `invalid` edge would
 * be a bigger UX change).
 */
export type AskQuestionAnswerKind = "free_text" | "buttons" | "list" | "number" | "date";

export interface AskQuestionStepConfig {
  question: string;
  timeoutHours: number;
  saveTo?: AskQuestionSaveTo;
  answerKind?: AskQuestionAnswerKind;
  options?: InteractiveOption[];
  listCtaLabel?: string;
  /**
   * Buttons/list only, Messenger + Instagram only: also offer Meta's one-tap
   * "share your phone / email" consent chips beside the options. The tapped
   * value is written to the contact and folds them into the right unified
   * `Customer` (`applyContactShareFromReply`) — the only route by which a social
   * contact ever gains a mergeable strong key. On a channel without the
   * `contactShareChips` capability (WhatsApp) the send raises
   * `contact_share_not_supported`, which routes to the `timeout` edge like any
   * other send failure, so the author's fallback branch still runs.
   */
  contactShare?: ContactShareField[];
  /** number kind only: inclusive bounds. */
  numberMin?: number;
  numberMax?: number;
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
  // WF-2 (fixed): this step is `irreversible` (the question SEND), AND it pauses
  // for a reply. A crash AFTER the send but BEFORE the runner persists the
  // await_reply state used to make the runner's skip-after-crash path ADVANCE
  // down an arbitrary edge, stranding the contact (they reply, but the run moved
  // on). The `awaitReply: true` flag now makes the runner's orphan-recovery path
  // RE-ARM the await (re-establish WorkflowAwaitingReply + pause) instead of
  // advancing — the send already happened, so it does NOT resend. See the
  // `producesAwaitReply` branch in runner.ts. Narrow window (crash in the ms gap
  // between send and await persist), but no longer mishandled.
  sideEffect: "irreversible",
  awaitReply: true,
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
    const answerKindRaw = typeof r.answerKind === "string" ? r.answerKind : undefined;
    const answerKind: AskQuestionAnswerKind =
      answerKindRaw === "buttons" ||
      answerKindRaw === "list" ||
      answerKindRaw === "number" ||
      answerKindRaw === "date"
        ? answerKindRaw
        : "free_text";
    let options: InteractiveOption[] | undefined;
    if (answerKind === "buttons" || answerKind === "list") {
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
    // Consent chips ride the interactive send, so they only mean something for
    // buttons/list. Reject at publish time rather than silently dropping them.
    let contactShare: ContactShareField[] | undefined;
    if (r.contactShare !== undefined) {
      if (!Array.isArray(r.contactShare)) {
        throw new StepConfigError("ask_question.contactShare must be an array");
      }
      const seenShare = new Set<string>();
      for (const f of r.contactShare) {
        if (f !== "phone" && f !== "email") {
          throw new StepConfigError(
            `ask_question.contactShare entries must be "phone" or "email" (got ${JSON.stringify(f)})`,
          );
        }
        if (seenShare.has(f)) {
          throw new StepConfigError(`ask_question.contactShare has duplicate entry "${f}"`);
        }
        seenShare.add(f);
      }
      if (seenShare.size > 0 && answerKind !== "buttons" && answerKind !== "list") {
        throw new StepConfigError(
          'ask_question.contactShare requires answerKind="buttons" or "list"',
        );
      }
      if (seenShare.size > 0) contactShare = [...seenShare] as ContactShareField[];
    }
    const listCtaLabel =
      typeof r.listCtaLabel === "string" && r.listCtaLabel.trim()
        ? r.listCtaLabel
        : undefined;
    let numberMin: number | undefined;
    let numberMax: number | undefined;
    if (answerKind === "number") {
      const minRaw = typeof r.numberMin === "number" ? r.numberMin : undefined;
      const maxRaw = typeof r.numberMax === "number" ? r.numberMax : undefined;
      if (minRaw !== undefined && !Number.isFinite(minRaw)) {
        throw new StepConfigError("ask_question.numberMin must be finite");
      }
      if (maxRaw !== undefined && !Number.isFinite(maxRaw)) {
        throw new StepConfigError("ask_question.numberMax must be finite");
      }
      if (minRaw !== undefined && maxRaw !== undefined && minRaw > maxRaw) {
        throw new StepConfigError(
          "ask_question.numberMin must be <= numberMax",
        );
      }
      numberMin = minRaw;
      numberMax = maxRaw;
    }
    return {
      question: r.question,
      timeoutHours: hours,
      ...(saveTo ? { saveTo } : {}),
      ...(answerKind !== "free_text" ? { answerKind } : {}),
      ...(options ? { options } : {}),
      ...(contactShare ? { contactShare } : {}),
      ...(listCtaLabel ? { listCtaLabel } : {}),
      ...(numberMin !== undefined ? { numberMin } : {}),
      ...(numberMax !== undefined ? { numberMax } : {}),
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
      let answered = ctx.pendingAnswer !== null && ctx.pendingAnswer !== undefined;
      // Number / date validation: a typed reply that fails to parse is
      // treated as a missed answer (routes to the timeout edge). This is
      // the right default for "ask how many seats?" + a contact replying
      // "next tuesday" — better to fall back to a clarifier than to feed
      // garbage into downstream steps.
      let parsedAnswer: string | null = null;
      if (answered && ctx.pendingAnswer) {
        if (config.answerKind === "number") {
          const n = parseAnswerNumber(ctx.pendingAnswer.body);
          const inRange =
            Number.isFinite(n) &&
            (config.numberMin === undefined || n >= config.numberMin) &&
            (config.numberMax === undefined || n <= config.numberMax);
          if (inRange) {
            parsedAnswer = String(n);
          } else {
            answered = false;
          }
        } else if (config.answerKind === "date") {
          const raw = ctx.pendingAnswer.body.trim();
          const ms = Date.parse(raw);
          if (Number.isFinite(ms)) {
            parsedAnswer = new Date(ms).toISOString();
          } else {
            answered = false;
          }
        }
      }
      // Clean up the awaiting row regardless of source. The ingest hook
      // also deletes on the answered path, so this is idempotent there;
      // on the timeout path the row is still present and this is the
      // canonical cleanup. deleteMany over delete to avoid throwing on
      // an already-gone row.
      await db.workflowAwaitingReply.deleteMany({
        where: { runId: ctx.runId },
      });

      // N-way label selection: if the contact tapped a button (or list row)
      // AND the graph has an outgoing edge labeled with that option id,
      // take it. Otherwise fall back to the generic "answered" / "timeout"
      // edges so free-text and unmatched answers still route somewhere.
      // The graph topology drives the choice; the handler doesn't need to
      // know whether the workflow author wired N option-edges or just
      // answered+timeout.
      const outgoingLabels = new Set(
        ctx.graph.edges
          .filter((e) => e.from === ctx.stepId)
          .map((e) => e.label ?? null),
      );
      const optionId = ctx.pendingAnswer?.optionId;
      const optionMatched =
        answered && optionId && outgoingLabels.has(optionId);
      // Free-text-on-buttons dead-end fallback: a contact who replies with FREE
      // TEXT to a buttons/list question arrives here answered=true but with no
      // matching option edge, so the generic "answered" label is selected. If
      // the author wired the N-way buttons shape (per-option edges + timeout,
      // NO "answered" edge), findNextStep exact-matches "answered", finds none,
      // and the run silently completes — the contact's reply is dropped. Route
      // such a reply to the author's fallback ("timeout") branch instead, but
      // ONLY when there's genuinely no "answered" edge to take and a "timeout"
      // edge exists. This is the same "route to timeout" escape the send-failure
      // and rate-limit paths already use. Leaves free_text mode (answered edge
      // wired) and matched-option taps untouched.
      const answeredWouldDeadEnd =
        answered &&
        !optionMatched &&
        !outgoingLabels.has("answered") &&
        outgoingLabels.has("timeout");
      const selectedLabel = optionMatched
        ? optionId!
        : answered
          ? answeredWouldDeadEnd
            ? "timeout"
            : "answered"
          : "timeout";

      // Save-to-field: persist the answer onto the contact's customFields
      // bag when configured. Only fires on the answered path — a timeout
      // shouldn't overwrite the field with an empty value (or worse,
      // clobber an existing answer from a prior question). Preference
      // order:
      //   - parsedAnswer (canonical form for number / date)
      //   - optionId (stable id for button / list taps)
      //   - raw body (free-text fallback)
      const valueToSave =
        parsedAnswer ?? ctx.pendingAnswer?.optionId ?? ctx.pendingAnswer?.body ?? "";
      if (answered && config.saveTo && ctx.pendingAnswer) {
        const c = envelopeContact(envelope);
        const contactId = c?.id;
        if (contactId) {
          const trimmed = valueToSave.slice(0, 2048);
          await saveAnswerToField(ctx.teamId, contactId, config.saveTo.key, trimmed);
        }
      }
      return {
        kind: "branch",
        status: 200,
        body: truncateBody(
          JSON.stringify({
            selected: selectedLabel,
            answer: answered ? ctx.pendingAnswer?.body ?? null : null,
            ...(answered && ctx.pendingAnswer?.optionId
              ? { optionId: ctx.pendingAnswer.optionId }
              : {}),
          }),
        ),
        selectedLabel,
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

    // Full trigger contact + sender so every $var token (incl. stage_name /
    // tag_names / window_state) resolves in the question copy.
    const { contact, extras } = await buildTokenContext(
      envelope,
      ctx,
      ctx.teamId,
      c.id,
    );
    const body = resolveFieldTokens(config.question, contact, extras);

    try {
      // Per-conversation send ceiling — same loop backstop as send_message.
      // A rate-limited question routes to the timeout edge (below) so the
      // author's fallback branch still runs instead of stalling the run.
      consumeConversationSendBudget(ctx.teamId, conversationId);
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
          ...(config.contactShare?.length ? { contactShare: config.contactShare } : {}),
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
      if (err instanceof ConversationSendRateLimitedError) {
        // Per-conversation budget exhausted — route to timeout like the
        // closed-window case so the author's fallback branch still runs.
        return {
          kind: "branch",
          status: 429,
          body: truncateBody(
            JSON.stringify({ selected: "timeout", error: "conversation_send_rate_limited" }),
          ),
          selectedLabel: "timeout",
        };
      }
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

/**
 * Persist the answer onto Contact.customFields, mirroring update-field.ts.
 *
 * CRITICAL: read the contact FRESH here — do NOT merge from the envelope's
 * contact snapshot. The envelope was captured at dispatch time, up to 7 days
 * ago (MAX_TIMEOUT_HOURS=168). Spreading its stale customFields would silently
 * delete every key edited during the pause window (agent UI, /v1 API, other
 * workflows). The `version` CAS turns a concurrent edit into a no-op-on-conflict
 * (the run can be retried) instead of a silent overwrite. We then publish
 * `contact.updated` (silent — step-driven, doesn't re-trigger workflows) so
 * realtime fanout / audit / analytics / outbound-webhooks all see the write,
 * exactly like update-field.ts.
 */
async function saveAnswerToField(
  teamId: string,
  contactId: string,
  key: string,
  value: string,
): Promise<void> {
  const contact = await db.contact.findFirst({
    where: { id: contactId, teamId },
    include: { tags: { select: { id: true } } },
  });
  if (!contact) return;

  const currentFields = normalizeStringMap(contact.customFields);
  const previousValue = currentFields[key] ?? null;
  if (previousValue === value) return;
  const nextFields = { ...currentFields, [key]: value };

  let updated;
  try {
    updated = await db.contact.update({
      where: { id: contactId, teamId, version: contact.version },
      data: {
        customFields: nextFields as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
      include: { tags: { select: { id: true } } },
    });
  } catch (err) {
    // CAS miss (a user/API edit landed between read and write) → drop the
    // save rather than clobber the concurrent write. The run already routed
    // on the answer; losing the field write is the safe failure here.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return;
    }
    throw err;
  }

  const payload: Contact = toContactWire(updated, {
    tagIds: updated.tags.map((t) => t.id),
  });

  await publish({
    type: "contact.updated",
    teamId,
    contact: payload,
    previousStageId: updated.stageId, // stage didn't change here
    fieldChanges: [{ key, previous: previousValue, next: value }],
    changedByUserId: null,
    workflowContact: workflowContactSnapshot(updated),
    // `silent: true` for loop safety; `skipOutboundWebhook: false` so a saved
    // answer reaches partners subscribed to contact.updated. Mirrors
    // update-field.ts (this path is the ask_question equivalent of update_field).
    silent: true,
    skipOutboundWebhook: false,
  });
}

