import { Global, Module } from "@nestjs/common";

import { WorkflowDispatcherService } from "./workflow-dispatcher.service";
import { WorkflowSubscribersService } from "./workflow-subscribers.service";
import { WorkflowWorkerService } from "./workflow-worker.service";

/**
 * Workflow engine inside the NestJS process. Three pieces:
 *
 *   - WorkflowWorkerService     starts/stops the BullMQ worker on lifecycle
 *                                hooks (gated by RUN_WORKER_INLINE).
 *   - WorkflowSubscribersService registers the bus subscribers that own
 *                                audit / analytics / dispatch side effects.
 *   - WorkflowDispatcherService  thin wrapper feature modules inject when
 *                                they need to fire dispatch directly (manual
 *                                trigger, test run).
 *
 * The actual engine code (queue, runner, 16 step handlers, conditions,
 * graph traversal) stays in [lib/workflows/](../../../../../lib/workflows/) —
 * it's framework-agnostic by design and serves both processes.
 *
 * Global so feature modules can inject WorkflowDispatcherService without
 * importing this module.
 */
@Global()
@Module({
  providers: [
    WorkflowWorkerService,
    WorkflowSubscribersService,
    WorkflowDispatcherService,
  ],
  exports: [WorkflowDispatcherService],
})
export class WorkflowsModule {}
