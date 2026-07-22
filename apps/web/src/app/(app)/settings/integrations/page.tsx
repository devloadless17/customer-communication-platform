import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowDown,
  ArrowRight,
  ExternalLink,
  Plug,
  Webhook,
  Workflow,
} from "lucide-react";

import { getSession } from "@/lib/auth/current-user";
import { listApiKeys } from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";
import { PageHeader } from "@/components/layouts/page-header";

import { ApiKeysManager } from "@/features/settings/integrations/components/api-keys-manager";
import { IntegrationConnectPanel } from "@/features/settings/integrations/components/integration-connect-panel";
import { N8N_PRESET } from "@/features/settings/integrations/presets";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

/**
 * Integrations landing page — the respond.io-style tile grid. Each tile
 * links to a management page (Webhooks) or a "Coming soon" disabled
 * state for tools we'll surface once the underlying capability ships.
 *
 * Admin-only — wiring a webhook or generating an integration key is the
 * kind of security-relevant action we don't want agents triggering.
 */
export default async function IntegrationsLanding() {
  const { user } = await getSession();
  if (!canManageUsers(user.role)) {
    redirect("/account");
  }

  // One round-trip serves both the "Connect" status on tiles AND the
  // connect panel's already-connected detection. Cheap (single SELECT,
  // never returns plaintext) and the page is `force-dynamic` anyway.
  const keys = await listApiKeys();
  const n8nConnected = keys.some(
    (k) => !k.revokedAt && k.name === N8N_PRESET.defaultName,
  );

  // The "AI Autopilot" tile is deliberately gone: it configured an EXTERNAL
  // (n8n) AI flow, which the built-in AI Assistant replaces — that one lives in
  // the product, needs no webhook wiring, and routes its human handoff through
  // Settings → Assignment like every other assignment. Offering both invited
  // orgs to configure two competing AIs and two competing handoff rules.
  //
  // The underlying flags and the /v1 endpoints stay for API stability, so any
  // org still running an n8n flow keeps working — there is just no longer a UI
  // to turn it ON for a new one.
  const tiles: Tile[] = [
    {
      href: "/settings/integrations/webhooks",
      icon: Webhook,
      title: "Webhooks",
      description:
        "Subscribe to events (message received, contact updated, …) and get HMAC-signed deliveries to a URL of your choice.",
      cta: "Manage",
    },
    {
      icon: Workflow,
      title: "n8n",
      description:
        "Use your API key with n8n's HTTP Request node. We document every /v1 endpoint and event so you can build flows in minutes.",
      cta: n8nConnected ? "Connected" : "Connect",
      connected: n8nConnected,
      href: "/settings/integrations#n8n",
    },
    {
      icon: Plug,
      title: "Make",
      description:
        "Make.com integration. Add a generic HTTP module today; native app coming soon.",
      disabled: true,
      cta: "Coming soon",
    },
    {
      icon: Plug,
      title: "Zapier",
      description:
        "Zapier integration. Use the Webhooks by Zapier app today; a native Zap is coming.",
      disabled: true,
      cta: "Coming soon",
    },
    {
      icon: Plug,
      title: "Google Sheets",
      description:
        "Append a row to a Sheet directly from a workflow. Wire it via the http_request workflow step today; native step coming soon.",
      disabled: true,
      cta: "Coming soon",
    },
  ];

  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Connect this workspace to the tools your team already uses. API keys let external systems drive the inbox; webhooks let the inbox push events back out."
        className="mb-8"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {tiles.map((t) => (
          <IntegrationTile key={t.title} {...t} />
        ))}
      </div>

      <div className="mt-6">
        <ApiKeysManager initialKeys={keys} />
      </div>

      <div className="mt-6">
        <IntegrationConnectPanel
          preset={N8N_PRESET}
          initialKeys={keys}
          instructions={
            <>
              <p>
                n8n doesn't need a custom node — the built-in HTTP Request node
                works with our /v1 API. Add a credential of type{" "}
                <code className="rounded bg-muted px-1 py-0.5">Header Auth</code>{" "}
                with header name{" "}
                <code className="rounded bg-muted px-1 py-0.5">Authorization</code>{" "}
                and value{" "}
                <code className="rounded bg-muted px-1 py-0.5">Bearer ccp_…</code>
                .
              </p>
              <div className="mt-2">
                <Link
                  href="/docs/api"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Full endpoint reference <ExternalLink className="size-3" />
                </Link>
              </div>
            </>
          }
        />
      </div>
    </div>
  );
}

interface Tile {
  href?: string;
  icon: typeof Webhook;
  title: string;
  description: string;
  cta: string;
  disabled?: boolean;
  connected?: boolean;
}

function IntegrationTile({
  href,
  icon: Icon,
  title,
  description,
  cta,
  disabled,
  connected,
}: Tile) {
  // A href with a `#` fragment scrolls to an inline section on THIS page
  // (e.g. n8n → #n8n) rather than navigating to a sub-page (e.g. Webhooks).
  // The affordance arrow must match: a downward "scroll to section" cue for
  // anchors, the navigate-style right arrow for real page links. Same hover
  // reveal either way — only the direction differs, so the arrow never lies.
  const isAnchor = !!href && href.includes("#");
  const Arrow = isAnchor ? ArrowDown : ArrowRight;
  const Inner = (
    <div className="flex h-full items-start gap-3">
      <div
        className={`flex size-9 shrink-0 items-center justify-center rounded-md ${
          disabled
            ? "bg-muted text-muted-foreground"
            : "bg-primary/10 text-primary group-hover:bg-primary/15"
        }`}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{title}</span>
          {!disabled && (
            <Arrow className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100" />
          )}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        <div
          className={`mt-2 inline-flex items-center gap-1 text-2xs font-medium ${
            connected ? "text-success-fg" : "text-muted-foreground"
          }`}
        >
          {connected && (
            <span className="size-1.5 rounded-full bg-success-fg" />
          )}
          {cta}
        </div>
      </div>
    </div>
  );

  if (disabled || !href) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 opacity-60">
        {Inner}
      </div>
    );
  }
  return (
    <Link
      href={href}
      className="group rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-accent/30"
    >
      {Inner}
    </Link>
  );
}
