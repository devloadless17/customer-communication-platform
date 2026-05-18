import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

import { RealtimeFanoutService } from "@/realtime/realtime-fanout.service";
import { registerAnalyticsSubscribers } from "@/lib/events/subscribers/analytics";
import { registerAuditSubscribers } from "@/lib/events/subscribers/audit";
import { registerWebCacheRevalidateSubscriber } from "@/lib/events/subscribers/web-cache-revalidate";
import { registerWorkflowDispatchSubscribers } from "@/lib/events/subscribers/workflow-dispatch";

/**
 * Single registration site for the bus subscribers that own audit /
 * analytics / dispatch / cache-revalidate / realtime-fanout side effects.
 *
 * Subscribers fire in parallel (Promise.allSettled in lib/events/bus.ts), so
 * registration order is purely cosmetic — the centralization here just keeps
 * the subscribers greppable from one place.
 *
 * The outbound-webhooks subscriber registers from its own module (it has no
 * inter-subscriber dependency and lives next to the BullMQ worker that
 * delivers the HTTP calls).
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

    this.logger.log("Bus subscribers registered");
  }
}
