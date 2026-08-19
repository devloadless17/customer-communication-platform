import type { WorkflowStepType } from "@prisma/client";

import { addCommentStepHandler } from "./add-comment";
import { askQuestionStepHandler } from "./ask-question";
import { assignToStepHandler } from "./assign-to";
import {
  branchStepHandler,
  jumpToStepHandler,
  waitStepHandler,
} from "./control-flow";
import { httpRequestStepHandler } from "./http-request";
import { noopStepHandler } from "./noop";
import {
  closeConversationStepHandler,
  openConversationStepHandler,
} from "./open-close-conversation";
import { sendConversionsEventStepHandler } from "./send-conversions-event";
import { sendMessageStepHandler } from "./send-message";
import { sendTemplateStepHandler } from "./send-template";
import { setStatusStepHandler } from "./set-status";
import {
  assignTicketStepHandler,
  createTicketStepHandler,
  setTicketPriorityStepHandler,
  setTicketStatusStepHandler,
} from "./ticket";
import { addTagStepHandler, removeTagStepHandler } from "./tag";
import { triggerWorkflowStepHandler } from "./trigger-workflow";
import { updateFieldStepHandler } from "./update-field";
import { updateLifecycleStepHandler } from "./update-lifecycle";
import type { StepHandler } from "./types";

/**
 * Step handler registry. Adding a new step type:
 *
 *   1. Add the value to WorkflowStepType in prisma/schema.prisma
 *   2. Write a handler module implementing StepHandler
 *   3. Add it to REGISTRY here
 *   4. Build a per-step editor in components/workflows/canvas/step-editors/
 *
 * Each handler module is self-contained: parseConfig + redactConfig (optional)
 * + describeConfig + run. The runner only ever calls methods on the
 * registry-returned handler — no per-type if/else outside this file.
 */

const REGISTRY: Record<WorkflowStepType, StepHandler<unknown>> = {
  send_message: sendMessageStepHandler as StepHandler<unknown>,
  send_template: sendTemplateStepHandler as StepHandler<unknown>,
  add_comment: addCommentStepHandler as StepHandler<unknown>,
  assign_to: assignToStepHandler as StepHandler<unknown>,
  set_status: setStatusStepHandler as StepHandler<unknown>,
  open_conversation: openConversationStepHandler as StepHandler<unknown>,
  close_conversation: closeConversationStepHandler as StepHandler<unknown>,
  create_ticket: createTicketStepHandler as StepHandler<unknown>,
  set_ticket_status: setTicketStatusStepHandler as StepHandler<unknown>,
  set_ticket_priority: setTicketPriorityStepHandler as StepHandler<unknown>,
  assign_ticket: assignTicketStepHandler as StepHandler<unknown>,
  add_tag: addTagStepHandler as StepHandler<unknown>,
  remove_tag: removeTagStepHandler as StepHandler<unknown>,
  update_field: updateFieldStepHandler as StepHandler<unknown>,
  update_lifecycle: updateLifecycleStepHandler as StepHandler<unknown>,
  branch: branchStepHandler as StepHandler<unknown>,
  wait: waitStepHandler as StepHandler<unknown>,
  jump_to_step: jumpToStepHandler as StepHandler<unknown>,
  noop: noopStepHandler as StepHandler<unknown>,
  ask_question: askQuestionStepHandler as StepHandler<unknown>,
  http_request: httpRequestStepHandler as StepHandler<unknown>,
  send_conversions_event: sendConversionsEventStepHandler as StepHandler<unknown>,
  trigger_workflow: triggerWorkflowStepHandler as StepHandler<unknown>,
};

export class UnknownStepTypeError extends Error {
  constructor(type: string) {
    super(`unknown step type: ${type}`);
    this.name = "UnknownStepTypeError";
  }
}

export function getStepHandler(type: WorkflowStepType): StepHandler<unknown> {
  const handler = REGISTRY[type];
  if (!handler) throw new UnknownStepTypeError(type);
  return handler;
}

export function parseStepConfig(type: WorkflowStepType, raw: unknown): unknown {
  return getStepHandler(type).parseConfig(raw);
}

// Both READ paths below resolve the handler INSIDE the try. A stored graph can
// name a step type this build no longer registers (a node saved by a newer
// deploy, a type removed) — and an UnknownStepTypeError escaping here 500s the
// workflows index and the GET, taking every other workflow down with the one
// bad node. Falling back to the raw type / config mirrors the runner, which
// fails the single step rather than the whole run.
export function redactStepConfig(type: WorkflowStepType, config: unknown): unknown {
  try {
    const handler = getStepHandler(type);
    if (!handler.redactConfig) return config;
    return handler.redactConfig(handler.parseConfig(config));
  } catch {
    return config;
  }
}

export function describeStep(type: WorkflowStepType, config: unknown): string {
  try {
    const handler = getStepHandler(type);
    if (!handler.describeConfig) return type;
    return handler.describeConfig(handler.parseConfig(config));
  } catch {
    return type;
  }
}
