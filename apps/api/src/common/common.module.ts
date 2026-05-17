import { Module } from "@nestjs/common";

/**
 * Cross-cutting utilities. Intentionally light — most of what feature
 * modules need is the ZodValidationPipe, which is instantiated per-route
 * with a schema rather than injected, so there's nothing to provide here
 * yet. The module exists so we have one place to add app-wide interceptors
 * (timing, error normalization) when needed.
 */
@Module({
  providers: [],
  exports: [],
})
export class CommonModule {}
