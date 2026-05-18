import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

import { registerAnalyticsSubscribers } from "@/lib/events/subscribers/analytics";
import { registerAuditSubscribers } from "@/lib/events/subscribers/audit";
import { registerWebCacheRevalidateSubscriber } from "@/lib/events/subscribers/web-cache-revalidate";
import { registerWorkflowDispatchSubscribers } from "@/lib/events/subscribers/workflow-dispatch";

/**
 * Register the bus subscribers that own the NestJS process's
 * post-event side effects: audit log writes, conversation analytics
 * updates, and workflow dispatch.
 *
 * Order matters — analytics must write `closedAt` / `firstResponseAt`
 * BEFORE workflow-dispatch reads them for `conversation_closed` /
 * `conversation_assigned` trigger snapshots.
 *
 * Post-Phase-5 these subscribers live exclusively on NestJS; the old
 * Next.js `registerAllSubscribers` and the SKIP_WORKFLOW_DISPATCH env
 * toggle that gated it during cutover are gone.
 *
 * Idempotent — guarded against double-registration via the bus's global
 * state and a local one-shot flag.
 */
@Injectable()
export class WorkflowSubscribersService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowSubscribersService.name);
  private registered = false;

  onModuleInit(): void {
    if (this.registered) return;
    this.registered = true;

    registerAuditSubscribers();
    registerAnalyticsSubscribers();
    registerWorkflowDispatchSubscribers();
    registerWebCacheRevalidateSubscriber();

    this.logger.log(
      "Bus subscribers registered: audit → analytics → workflow-dispatch → web-cache-revalidate",
    );
  }
}
