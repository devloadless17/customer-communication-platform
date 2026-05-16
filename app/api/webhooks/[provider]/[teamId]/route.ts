import { NextResponse } from "next/server";

import { getMetaWebhookConfig } from "@/lib/providers/config";
// Importing the index file triggers the side-effect that registers every
// provider with the webhook registry (lib/providers/webhook.ts). Don't drop
// this even if the symbol isn't used — without it `getWebhookProvider`
// returns null on cold start.
import "@/lib/providers";
import { ingestEvents } from "@/lib/providers/ingest";
import type { ProviderName } from "@prisma/client";
import {
  getWebhookProvider,
  type ProviderWebhookSecrets,
} from "@/lib/providers/webhook";

/**
 * Channel-agnostic webhook dispatcher.
 *
 *   GET  /api/webhooks/<provider>/<teamId>   → provider's subscription dance
 *   POST /api/webhooks/<provider>/<teamId>   → real events
 *
 * Looks up the registered {@link WebhookProvider} by URL segment, loads the
 * per-team secrets it needs (lib/providers/config.ts), runs verify, then
 * parses into normalized events and hands off to the shared ingest pipeline.
 *
 * Adding a channel = drop a new WebhookProvider + register it in
 * lib/providers/index.ts + extend `loadSecretsForProvider` below. No new
 * route file.
 *
 * The existing /api/webhooks/meta/[teamId] route stays as the Meta-only
 * legacy URL (Meta dashboards already point at it). Channel #2 onwards
 * use this dispatcher.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ provider: string; teamId: string }> },
) {
  const { provider, teamId } = await ctx.params;
  const adapter = getWebhookProvider(provider);
  if (!adapter || !adapter.verifyChallenge) {
    // 405 here would leak provider-name enumeration; mirror the Meta route's
    // silent 403 for unknown / unconfigured providers. We still log so a
    // typo'd subscription URL ("metacloud" vs "meta_cloud") doesn't fail
    // invisibly during a customer onboarding session.
    if (!adapter) {
      console.warn(
        `[webhook] GET unknown provider slug "${provider}" for team=${teamId}`,
      );
    }
    return new NextResponse("forbidden", { status: 403 });
  }
  const secrets = await loadSecretsForProvider(adapter.name, teamId);
  if (!secrets) return new NextResponse("forbidden", { status: 403 });

  const echo = adapter.verifyChallenge({ url: new URL(req.url), secrets });
  if (!echo) return new NextResponse("forbidden", { status: 403 });
  return new NextResponse(echo, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ provider: string; teamId: string }> },
) {
  const { provider, teamId } = await ctx.params;
  const adapter = getWebhookProvider(provider);
  if (!adapter) {
    console.warn(
      `[webhook] POST unknown provider slug "${provider}" for team=${teamId}`,
    );
    return new NextResponse("forbidden", { status: 403 });
  }

  const secrets = await loadSecretsForProvider(adapter.name, teamId);
  if (!secrets) return new NextResponse("forbidden", { status: 403 });

  // Raw body for signature verification. Calling .json() re-serializes and
  // would break HMAC schemes that signed the EXACT bytes (Meta, Instagram).
  const rawBody = await req.text();
  if (!adapter.verifyPost({ rawBody, headers: req.headers, secrets })) {
    return new NextResponse("forbidden", { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true, dropped: "malformed" });
  }

  const events = adapter.parse(payload);
  if (events.length === 0) {
    return NextResponse.json({ ok: true, ingested: 0 });
  }

  try {
    await ingestEvents(teamId, adapter.name, events);
  } catch (err) {
    console.error(`[webhook ${adapter.name} ${teamId}] ingest failed`, err);
    return new NextResponse("ingest failed", { status: 500 });
  }

  return NextResponse.json({ ok: true, ingested: events.length });
}

/**
 * Map provider name → the bag of secrets that provider's verify methods
 * need. Today only Meta is registered; future providers extend the switch.
 */
async function loadSecretsForProvider(
  provider: ProviderName,
  teamId: string,
): Promise<ProviderWebhookSecrets | null> {
  switch (provider) {
    case "meta_cloud": {
      const config = await getMetaWebhookConfig(teamId);
      if (!config) return null;
      return { appSecret: config.appSecret, verifyToken: config.verifyToken };
    }
    default:
      return null;
  }
}
