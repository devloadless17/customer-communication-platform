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
 * Subscribers fire SEQUENTIALLY in `SubscriberPriority` order (see
 * lib/events/bus.ts) — the order is LOAD-BEARING (workflow-dispatch reads
 * what analytics writes). Each register*() call below declares its own
 * priority tier, so the order here is for greppability only; it does NOT
 * determine execution order. Do NOT re-parallelize the bus.
 *
 * The outbound-webhooks subscriber registers from its own module at the
 * OUTBOUND_WEBHOOKS tier (it ships partner payloads carrying analytics'
 * post-mutation fields, so it must run last) and lives next to the BullMQ
 * worker that delivers the HTTP calls.
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
