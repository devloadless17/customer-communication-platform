import { Injectable, OnModuleInit } from "@nestjs/common";

import { EventBus } from "../events/event-bus.module";
import { RealtimeEmitter } from "./emitter.service";
import { FANOUT_RULES } from "./fanout-rules";

/**
 * Subscribes the bus → wire-emit rules to the domain event bus.
 *
 * All payload logic lives in `fanout-rules.ts` — this service is just the
 * wiring loop. Adding a new event type means editing one rules-table entry
 * with no changes here.
 *
 * Subscription mode is `"any"` so events forwarded from another process
 * (via a future Redis bus bridge) still reach connected browsers. With no
 * bridge today, `"any"` collapses to `"local"` automatically.
 */
@Injectable()
export class RealtimeFanoutService implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly emitter: RealtimeEmitter,
  ) {}

  onModuleInit(): void {
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
