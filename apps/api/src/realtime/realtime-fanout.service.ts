import { Injectable } from "@nestjs/common";

import { EventBus } from "../events/event-bus.module";
import { RealtimeEmitter } from "./emitter.service";
import { FANOUT_RULES } from "./fanout-rules";

/**
 * Subscribes the bus → wire-emit rules to the domain event bus.
 *
 * Subscribers run in parallel (Promise.allSettled), so registration order
 * does not affect observability — each handler owns its own table writes
 * or socket emits and any two-subscriber ordering would need to be modeled
 * explicitly in their state. Central registration here just keeps wire-
 * emit rules together in one greppable place.
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
      );
    }
  }
}
