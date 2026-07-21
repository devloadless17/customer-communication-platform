import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import {
  startContactTransferWorker,
  stopContactTransferWorker,
} from "@/lib/contact-transfer/worker";
import { closeContactTransferQueue } from "@/lib/contact-transfer/queue";
import { startContactTransferSweeper, stopContactTransferSweeper } from "@/lib/sweepers/contact-transfer-artifacts";

/**
 * Nest lifecycle owner for the contact-transfer worker + its artifact sweeper.
 * Same shape as WorkflowWorkerService / SendWorkerService: the queue plumbing
 * stays framework-agnostic in lib/, and exactly one Nest provider starts and
 * drains it.
 *
 * Workers run in-process (`RUN_WORKER_INLINE`) — there is no external worker
 * entrypoint, and prod refuses to start with it off.
 */
@Injectable()
export class ContactTransferWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContactTransferWorkerService.name);

  onModuleInit(): void {
    if (process.env.RUN_WORKER_INLINE === "0") {
      this.logger.log("RUN_WORKER_INLINE=0 — contact-transfer worker not started");
      return;
    }
    startContactTransferWorker();
    startContactTransferSweeper();
  }

  async onModuleDestroy(): Promise<void> {
    // Drain in order: stop accepting new work, stop the sweeper, then release
    // the queue's Redis connection. A transfer in flight finishes its current
    // batch; its resume cursor covers whatever it didn't reach.
    stopContactTransferSweeper();
    await stopContactTransferWorker();
    await closeContactTransferQueue();
  }
}
