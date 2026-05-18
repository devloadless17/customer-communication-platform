import { Injectable } from "@nestjs/common";

import { EventBus } from "../events/event-bus.module";
import { RealtimeEmitter } from "./emitter.service";
import { FANOUT_RULES } from "./fanout-rules";

/**
 * Subscribes the bus → wire-emit rules to the domain event bus.
 *
 * Subscriber-registration is EXPLICIT (called from
 * `EventSubscribersOrchestrator.onModuleInit`) rather than driven by Nest
 * `OnModuleInit` topology. Reason: the documented canonical fire order is
 *   socket-fanout → audit → analytics → workflow-dispatch → cache-revalidate
 *                → outbound-webhooks
 * and the bus fires subscribers in REGISTRATION order. Nest topology
 * doesn't guarantee inter-module init ordering, so relying on
 * `OnModuleInit` here would silently let audit fire before socket-fanout
 * on the day someone adds a `forwardRef` — agents would see timeline rows
 * appear in another tab before the broadcast frame arrived. The single
 * registration site below pins the order.
 *
 * Subscription mode is `"any"` so events forwarded from another process
 * (via the Redis bus bridge) still reach connected browsers. With no
 * bridge today, `"any"` collapses to `"local"` automatically.
 */
@Injectable()
export class RealtimeFanoutService {
  constructor(
    private readonly bus: EventBus,
    private readonly emitter: RealtimeEmitter,
  ) {}

  registerSubscribers(): void {
    for (const rule of FANOUT_RULES) {
      // The discriminated union forces handlers to match their declared
      // `type`, but the iterator widens to the union — so we narrow per
      // iteration the way the bus expects.
      this.bus.subscribe(
        rule.type,
        (e) => (rule.handle as (e: unknown, emitter: RealtimeEmitter) => void)(e, this.emitter),
        { mode: "any" },
      );
    }
  }
}
