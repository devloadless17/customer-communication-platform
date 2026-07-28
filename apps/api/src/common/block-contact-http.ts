import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from "@nestjs/common";

import { BlockContactError } from "@/lib/messaging/block-contact";

/**
 * BlockContactError → structured HTTP error, shared by the internal contacts
 * controller and its `/v1` mirror so both surfaces speak the same codes.
 * Everything except not-found / rate-limit is a 400: they're operator-
 * actionable provider constraints (Meta's 24h re-engagement rule, the 64,000-
 * entry blocklist cap), not server faults. Non-BlockContactError values pass
 * through untouched for the global filters to handle.
 */
export function mapBlockContactError(err: unknown): unknown {
  if (!(err instanceof BlockContactError)) return err;
  const body = {
    error: err.code,
    detail: err.detail ?? err.message,
  };
  if (err.code === "contact_not_found") return new NotFoundException(body);
  if (err.code === "rate_limited") return new HttpException(body, 429);
  return new BadRequestException(body);
}
