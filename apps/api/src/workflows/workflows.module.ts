import { Module } from "@nestjs/common";

import { WorkspaceSettingsModule } from "../workspace-settings/workspace-settings.module";

import { WorkflowSubscribersService } from "./workflow-subscribers.service";
import { WorkflowWorkerService } from "./workflow-worker.service";

/**
 * Workflow engine inside the NestJS process. Two pieces:
 *
 *   - WorkflowWorkerService     starts/stops the BullMQ worker on lifecycle
 *                                hooks (gated by RUN_WORKER_INLINE).
 *   - WorkflowSubscribersService registers the bus subscribers that own
 *                                audit / analytics / dispatch side effects.
 *
 * The actual engine code (queue, runner, 16 step handlers, conditions,
 * graph traversal) stays in [lib/workflows/](../../../../../lib/workflows/) —
 * it's framework-agnostic by design. Feature modules that need to fire
 * dispatch directly (manual trigger, test run) import the lib functions
 * (`dispatch`, `dispatchManualTrigger`) without going through Nest DI.
 */
@Module({
  // WorkspaceSettingsModule exports WorkspaceRootService — the ONE real
  // implementation of "destroy a tenant". The abandoned-registration sweeper
  // is handed that method rather than growing a second delete path.
  imports: [WorkspaceSettingsModule],
  providers: [WorkflowWorkerService, WorkflowSubscribersService],
})
export class WorkflowsModule {}
