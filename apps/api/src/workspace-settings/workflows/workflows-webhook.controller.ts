import {
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";

import { WorkflowWebhookRateLimitGuard } from "@/webhooks/webhook-rate-limit.guard";

import { WorkflowsService } from "./workflows.service";

/**
 * Per-workflow incoming webhook — public endpoint, HMAC-SHA256 over the
 * raw body in `X-Workflow-Signature` is the only authentication gate.
 *
 * `WorkflowWebhookRateLimitGuard` runs ahead of the HMAC check so a
 * leaked-secret flood (or signature-fuzz attack) is bucket-limited before
 * it hits Prisma + the envelope-decrypt. Per-workflow + per-IP buckets.
 *
 * Separate controller (no session guard) so the rest of /api/workspace/workflows
 * can keep its admin/session guards. The raw body lives on `req.rawBody`
 * thanks to main.ts's bodyParser.verify capture hook.
 */
@Controller("api/workspace/workflows")
@UseGuards(WorkflowWebhookRateLimitGuard)
export class WorkflowsIncomingWebhookController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Post(":id/incoming-webhook")
  @HttpCode(200)
  async incoming(
    @Param("id") id: string,
    @Headers("x-workflow-signature") signature: string | undefined,
    @Headers("x-workflow-timestamp") timestamp: string | undefined,
    @Req() req: Request,
  ) {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    // Stringify even on missing body — service validates against the
    // signature and treats an unparseable body as `{ raw: "" }`.
    const rawBodyStr = rawBody ? rawBody.toString("utf-8") : "";

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }

    const out = await this.workflows.incomingWebhook(
      id,
      rawBodyStr,
      signature ?? "",
      timestamp,
      headers,
    );
    return { ok: true, ...out };
  }
}
