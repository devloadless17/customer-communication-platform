import { Injectable } from "@nestjs/common";

import type { DomainEventType } from "@ccp/shared/events/types";

import { EventBus } from "../events/event-bus.module";
import { RealtimeEmitter } from "./emitter.service";
import { FANOUT_RULES } from "./fanout-rules";

/**
 * Subscribes the bus → wire-emit rules to the domain event bus.
 *
 * Registered FIRST in the chain (see WorkflowSubscribersService) so live
 * clients see state mutations before audit/analytics/workflow-dispatch
 * sequence their slower writes. The bus runs subscribers sequentially in
 * registration order — see `bus.ts` head comment for the ordering
 * invariant downstream subscribers rely on.
 *
 * Central registration here just keeps wire-emit rules together in one
 * greppable place.
 */
@Injectable()
export class RealtimeFanoutService {
  constructor(
    private readonly bus: EventBus,
    private readonly emitter: RealtimeEmitter,
  ) {}

  registerSubscribers(): void {
    for (const [type, handler] of Object.entries(FANOUT_RULES) as Array<
      [DomainEventType, (typeof FANOUT_RULES)[DomainEventType]]
    >) {
      // `null` entries are the explicit "no socket frame" opt-out — narrow
      // events that the type system requires be present in the table but
      // shouldn't fan out. Skip without subscribing.
      if (handler === null) continue;
      // Per-key handler is `Handler<K>` for its own K, but Object.entries
      // widens to the union — cast per iteration the way the bus expects.
      this.bus.subscribe(
        type,
        (e) => (handler as (e: unknown, emitter: RealtimeEmitter) => void)(e, this.emitter),
      );
    }
  }
}
