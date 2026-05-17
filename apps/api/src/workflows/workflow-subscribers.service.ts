import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

import { registerAnalyticsSubscribers } from "@/lib/events/subscribers/analytics";
import { registerAuditSubscribers } from "@/lib/events/subscribers/audit";
import { registerWorkflowDispatchSubscribers } from "@/lib/events/subscribers/workflow-dispatch";

/**
 * Register the bus subscribers that own the NestJS process's
 * post-event side effects: audit log writes, conversation analytics
 * updates, and workflow dispatch.
 *
 * These mirror what [lib/events/subscribers/index.ts](../../../../../lib/events/subscribers/index.ts)
 * does on the Next.js side. The ORDER MATTERS — analytics must write
 * `closedAt` / `firstResponseAt` BEFORE workflow-dispatch reads them
 * for `conversation_closed` / `conversation_assigned` trigger snapshots.
 *
 * Coexistence with the Next.js side during the migration window:
 *   - Pre-Phase 4: Next.js owns these subscribers. NestJS doesn't register
 *     them (this service shouldn't be imported — see workflows.module.ts).
 *   - Phase 4 cutover: NestJS registers them here. Next.js's
 *     `registerAllSubscribers` is gated by `SKIP_WORKFLOW_DISPATCH=1` so
 *     the same event doesn't trigger workflows twice.
 *   - Post-cutover: every bus publish (whether origin is Next.js routes
 *     forwarded over the Redis bridge, or NestJS routes / workflow
 *     handlers in-process) lands these subscribers in NestJS.
 *
 * Idempotent — guarded against double-registration via the bus's global
 * state and a local one-shot flag.
 */
@Injectable()
export class WorkflowSubscribersService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowSubscribersService.name);
  private registered = false;

  onModuleInit(): void {
    // Opt-out for the window where this is co-running with the Next.js
    // subscribers. Default ON in NestJS so post-Phase-4 deploys just work.
    if (process.env.SKIP_WORKFLOW_DISPATCH === "1") {
      this.logger.log("SKIP_WORKFLOW_DISPATCH=1 — Next.js side owns audit/analytics/dispatch");
      return;
    }
    if (this.registered) return;
    this.registered = true;

    registerAuditSubscribers();
    registerAnalyticsSubscribers();
    registerWorkflowDispatchSubscribers();

    this.logger.log("Bus subscribers registered: audit → analytics → workflow-dispatch");
  }
}
