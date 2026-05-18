import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from "@nestjs/common";
import type { ZodTypeAny, z } from "zod";

/**
 * Zod-backed pipe. Designed to drop in next to controllers and reuse the
 * exact schemas already written for Next.js route handlers in `app/api/**`.
 *
 * Two usage patterns:
 *
 *   // Per-handler, single body:
 *   @Post()
 *   create(@Body(new ZodBody(CreateMessageSchema)) body: CreateMessage) {}
 *
 *   // Per-handler, single query:
 *   @Get()
 *   list(@Query(new ZodQuery(ListSchema)) q: ListInput) {}
 *
 * Rejected alternative: a global ValidationPipe wired via `useGlobalPipes`.
 * That requires class DTOs + class-validator which would force duplicating
 * every schema — we have ~60 zod schemas already; reuse them.
 */
@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: "invalid_body",
        issues: result.error.issues,
      });
    }
    return result.data;
  }
}

/** Sugar so route signatures stay readable: `@Body(zBody(Schema))`. */
export const zBody = <T extends ZodTypeAny>(schema: T) =>
  new ZodValidationPipe(schema);
/** Sugar for query strings. */
export const zQuery = <T extends ZodTypeAny>(schema: T) =>
  new ZodValidationPipe(schema);
/** Sugar for path params. */
export const zParam = <T extends ZodTypeAny>(schema: T) =>
  new ZodValidationPipe(schema);
