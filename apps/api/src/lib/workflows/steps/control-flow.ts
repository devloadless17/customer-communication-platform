import { evaluateConditions } from "@/lib/workflows/conditions";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advanceWithError,
} from "./types";

/**
 * Control-flow steps: branch, wait, jump_to_step.
 *
 * Branch picks an outgoing edge based on a condition group; the runner uses
 * `selectedLabel` to find the right edge in the DAG. Wait pauses the run
 * for `delayMs`; the runner schedules a delayed BullMQ job and marks the
 * run `waiting`. Jump moves to a specific node id; the runner increments
 * `jumpsUsed` and bails out when the per-run jump cap is exceeded.
 */

// ---------------------------------------------------------------------------
// Branch
// ---------------------------------------------------------------------------

export interface BranchStepConfig {
  conditions: unknown;
}

export const branchStepHandler: StepHandler<BranchStepConfig> = {
  type: "branch",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("branch config must be an object");
    }
    const r = raw as Record<string, unknown>;
    // Tolerant — the canvas may stub a branch with no conditions yet.
    // Falsy/empty conditions evaluate true (matches everything).
    return { conditions: r.conditions ?? { op: "AND", children: [] } };
  },
  describeConfig() {
    return "Branch";
  },
  async run(envelope, config): Promise<StepResult> {
    const matched = evaluateConditions(config.conditions, envelope.data);
    return {
      kind: "branch",
      status: 200,
      body: JSON.stringify({ selected: matched ? "true" : "false" }),
      selectedLabel: matched ? "true" : "false",
    };
  },
};

// ---------------------------------------------------------------------------
// Wait
// ---------------------------------------------------------------------------

export interface WaitStepConfig {
  /** Duration to pause. Validated to be 1ms — 90 days. */
  delayMs: number;
}

const MIN_DELAY_MS = 1;
const MAX_DELAY_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export const waitStepHandler: StepHandler<WaitStepConfig> = {
  type: "wait",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("wait config must be an object");
    }
    const r = raw as Record<string, unknown>;
    const n = typeof r.delayMs === "number" ? r.delayMs : Number.parseInt(String(r.delayMs ?? ""), 10);
    if (!Number.isFinite(n) || n < MIN_DELAY_MS || n > MAX_DELAY_MS) {
      throw new StepConfigError(`wait.delayMs must be a number between ${MIN_DELAY_MS} and ${MAX_DELAY_MS}`);
    }
    return { delayMs: n };
  },
  describeConfig(config) {
    return `Wait ${humanize(config.delayMs)}`;
  },
  async run(_envelope, config): Promise<StepResult> {
    return {
      kind: "wait",
      status: 200,
      body: JSON.stringify({ delayMs: config.delayMs }),
      delayMs: config.delayMs,
    };
  },
};

function humanize(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

// ---------------------------------------------------------------------------
// Jump
// ---------------------------------------------------------------------------

export interface JumpToStepConfig {
  targetStepId: string;
  /**
   * Per-workflow ceiling on how many times this step can fire for a given
   * run. Combined with the runner's global per-run step ceiling (100), it
   * lets authors set a tighter local cap on a specific loop. Optional.
   */
  maxJumps?: number;
}

export const jumpToStepHandler: StepHandler<JumpToStepConfig> = {
  type: "jump_to_step",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("jump_to_step config must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.targetStepId !== "string" || !r.targetStepId) {
      throw new StepConfigError("jump_to_step.targetStepId must be a non-empty string");
    }
    const maxJumps =
      typeof r.maxJumps === "number" && r.maxJumps > 0 ? Math.floor(r.maxJumps) : undefined;
    return { targetStepId: r.targetStepId, ...(maxJumps !== undefined ? { maxJumps } : {}) };
  },
  describeConfig(c) {
    return `Jump to ${c.targetStepId}`;
  },
  async run(_envelope, config, ctx): Promise<StepResult> {
    // Target validation: must exist in graph. The runner double-checks this
    // when it advances, but failing fast at the step level produces a
    // cleaner step log entry.
    const targetExists = ctx.graph.nodes.some((n) => n.id === config.targetStepId);
    if (!targetExists) {
      return advanceWithError(
        404,
        "jump_target_not_found",
        `step "${config.targetStepId}" does not exist in graph`,
      );
    }
    return {
      kind: "jump",
      status: 200,
      body: JSON.stringify({ target: config.targetStepId }),
      targetStepId: config.targetStepId,
    };
  },
};
