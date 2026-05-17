import { Injectable } from "@nestjs/common";

import { dispatch, dispatchManualTrigger } from "@/lib/workflows/dispatcher";

/**
 * Thin Nest wrapper over the workflow dispatcher. Feature modules inject
 * this rather than importing from `@/lib/workflows/dispatcher` directly.
 *
 * The dispatcher itself is framework-agnostic — see
 * [lib/workflows/dispatcher.ts](../../../../../lib/workflows/dispatcher.ts).
 */
@Injectable()
export class WorkflowDispatcherService {
  /**
   * Fire any matching workflows for a domain event. Called from the
   * workflow-dispatch bus subscriber (see ../events/subscribers/).
   */
  dispatch(...args: Parameters<typeof dispatch>): Promise<void> {
    return dispatch(...args);
  }

  /**
   * Manually trigger a specific workflow from the admin UI. The `runs`
   * sub-route + manual-trigger button drive this.
   */
  dispatchManualTrigger(args: Parameters<typeof dispatchManualTrigger>[0]) {
    return dispatchManualTrigger(args);
  }
}
