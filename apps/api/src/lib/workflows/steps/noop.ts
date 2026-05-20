import { advance, type StepHandler, type StepResult } from "./types";

/**
 * "Do Nothing" step. Useful as the explicit terminator for a branch path the
 * author wants to dead-end (e.g. Branch → false → Noop) so the canvas doesn't
 * read like an unfinished workflow. Returns immediately; pure (no side
 * effect), no retries needed.
 */

export type NoopStepConfig = Record<string, never>;

export const noopStepHandler: StepHandler<NoopStepConfig> = {
  type: "noop",
  sideEffect: "pure",
  parseConfig(): NoopStepConfig {
    return {};
  },
  describeConfig(): string {
    return "Do nothing";
  },
  async run(): Promise<StepResult> {
    return advance({ status: "ok" });
  },
};
