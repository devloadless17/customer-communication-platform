import {
  type StepHandler,
  type StepResult,
  StepConfigError,
} from "./types";
import { runSetStatus } from "./set-status";

/**
 * `open_conversation` and `close_conversation` are thin specializations of
 * `set_status` exposed as their own step types in the UI (the user shouldn't
 * have to know about a generic status field — they should see "Open" and
 * "Close" as distinct actions on the palette).
 *
 * `close_conversation` additionally captures `category` + `summary` —
 * fields the inbox UI shows in the close-confirmation dialog. Both are
 * optional; null when not set.
 */

export const openConversationStepHandler: StepHandler<Record<string, never>> = {
  type: "open_conversation",
  parseConfig(_raw) {
    // No config — opening is just "set status = open" with no extras.
    return {};
  },
  describeConfig() {
    return "Open conversation";
  },
  async run(envelope, _config, ctx): Promise<StepResult> {
    return runSetStatus(envelope, "open", {}, ctx);
  },
};

export interface CloseConversationStepConfig {
  category?: string;
  summary?: string;
}

export const closeConversationStepHandler: StepHandler<CloseConversationStepConfig> = {
  type: "close_conversation",
  parseConfig(raw) {
    if (raw == null) return {};
    if (typeof raw !== "object") {
      throw new StepConfigError("close_conversation config must be an object");
    }
    const r = raw as Record<string, unknown>;
    const out: CloseConversationStepConfig = {};
    if (typeof r.category === "string" && r.category) out.category = r.category;
    if (typeof r.summary === "string" && r.summary) out.summary = r.summary;
    return out;
  },
  describeConfig(config) {
    return config.category ? `Close (${config.category})` : "Close conversation";
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    return runSetStatus(
      envelope,
      "closed",
      {
        closedCategory: config.category ?? null,
        closedSummary: config.summary ?? null,
      },
      ctx,
    );
  },
};
