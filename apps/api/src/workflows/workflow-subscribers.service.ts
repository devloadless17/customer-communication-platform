import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { RealtimeFanoutService } from "@/realtime/realtime-fanout.service";
import { registerAnalyticsSubscribers } from "@/lib/events/subscribers/analytics";
import { registerAuditSubscribers } from "@/lib/events/subscribers/audit";
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
export class WorkflowSubscribersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowSubscribersService.name);
  private registered = false;
  // Unsubscribe callbacks captured at registration time. Called on shutdown
  // so a hot-reload / programmatic NestFactory restart can't double-register
  // handlers. Without this, every re-init layered a second copy of each
  // subscriber on the `globalThis.__ccpEventBus` map — every event then
  // fired every subscriber twice, producing double Meta sends, double
  // outbound webhook deliveries, double audit rows. The `registered`
  // flag at the top guards single-process re-init within ONE lifecycle;
  // these unsubs guard MULTI-lifecycle within one process (test harness,
  // dev hot-restart, future programmatic re-init).
  private unsubs: Array<() => void> = [];

  constructor(private readonly realtimeFanout: RealtimeFanoutService) {}

  onModuleInit(): void {
    if (this.registered) return;
    this.registered = true;

    this.unsubs.push(this.realtimeFanout.registerSubscribers());
    this.unsubs.push(registerAuditSubscribers());
    this.unsubs.push(registerAnalyticsSubscribers());
    this.unsubs.push(registerWorkflowDispatchSubscribers());

    this.logger.log("Bus subscribers registered");
  }

  onModuleDestroy(): void {
    for (const off of this.unsubs) {
      try {
        off();
      } catch (err) {
        this.logger.warn(
          `unsubscribe failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    this.unsubs = [];
    this.registered = false;
  }
}
