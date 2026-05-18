import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

import { RealtimeFanoutService } from "@/realtime/realtime-fanout.service";
import { registerAnalyticsSubscribers } from "@/lib/events/subscribers/analytics";
import { registerAuditSubscribers } from "@/lib/events/subscribers/audit";
import { registerWebCacheRevalidateSubscriber } from "@/lib/events/subscribers/web-cache-revalidate";
import { registerWorkflowDispatchSubscribers } from "@/lib/events/subscribers/workflow-dispatch";

/**
 * The ONE place that pins the canonical bus-subscriber registration order.
 *
 * The bus fires subscribers in the order they were registered (lib/events/
 * bus.ts:runSubscribers). Multiple modules previously each registered from
 * their own `OnModuleInit`, leaving relative order at the mercy of Nest's
 * module-topology resolution — i.e. a single `forwardRef` refactor could
 * silently move audit/analytics ahead of socket-fanout. Centralising the
 * registration here makes the order load-bearing on purpose:
 *
 *   1. realtime-fanout       — push to connected sockets FIRST, so agents
 *                              see the change before the DB writes that
 *                              come next (especially in another tab/agent
 *                              where the audit timeline row needs to land
 *                              after the live wire frame, not before).
 *   2. audit                 — append the timeline row (which itself
 *                              publishes `conversation.event_recorded`,
 *                              picked up by realtime-fanout for the
 *                              audit-panel viewers).
 *   3. analytics             — write `closedAt`/`firstResponseAt` etc.,
 *                              which workflow-dispatch reads next.
 *   4. workflow-dispatch     — dispatch trigger-matching workflows.
 *   5. web-cache-revalidate  — RSC cache invalidation, async by design,
 *                              ordering doesn't matter beyond "not first".
 *
 * The outbound-webhooks subscriber registers separately from its own module
 * (it sits OUTSIDE this orchestrator on purpose — it has no inter-subscriber
 * timing constraint, and a missed registration here would silently drop
 * customer-facing delivery).
 *
 * Idempotent — `registered` flag + the bus's per-process global state.
 */
@Injectable()
export class WorkflowSubscribersService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowSubscribersService.name);
  private registered = false;

  constructor(private readonly realtimeFanout: RealtimeFanoutService) {}

  onModuleInit(): void {
    if (this.registered) return;
    this.registered = true;

    this.realtimeFanout.registerSubscribers();
    registerAuditSubscribers();
    registerAnalyticsSubscribers();
    registerWorkflowDispatchSubscribers();
    registerWebCacheRevalidateSubscriber();

    this.logger.log(
      "Bus subscribers registered: realtime-fanout → audit → analytics → " +
        "workflow-dispatch → web-cache-revalidate",
    );
  }
}
