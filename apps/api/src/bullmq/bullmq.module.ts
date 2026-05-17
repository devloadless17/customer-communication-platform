import { Global, Module } from "@nestjs/common";
import { Redis } from "ioredis";

export const BULLMQ_REDIS = "BULLMQ_REDIS";

/**
 * Shared IORedis connection for BullMQ producers + workers.
 *
 * Phase 1 just provides the connection — queues themselves are introduced
 * in Phase 4 when the workflow engine moves over. Splitting the connection
 * factory out now keeps later modules from each rolling their own.
 *
 * `maxRetriesPerRequest` MUST be null for BullMQ (it does its own retry
 * orchestration on top). `enableReadyCheck: false` keeps reconnect noise
 * out of the worker logs under transient Redis hiccups — BullMQ recovers
 * fine on its own.
 */
@Global()
@Module({
  providers: [
    {
      provide: BULLMQ_REDIS,
      useFactory: (): Redis => {
        const url = process.env.REDIS_URL;
        if (!url) {
          throw new Error("REDIS_URL must be set for BullMQ");
        }
        return new Redis(url, {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          lazyConnect: false,
        });
      },
    },
  ],
  exports: [BULLMQ_REDIS],
})
export class BullMQModule {}
