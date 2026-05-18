import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  ExternalLink,
  KeyRound,
  Plug,
  Webhook,
  Workflow,
} from "lucide-react";

import { getSession } from "@/lib/auth/current-user";
import { canManageUsers } from "@ccp/shared/auth/permissions";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

/**
 * Integrations landing page — the respond.io-style tile grid. Each tile
 * links to either an existing page (API keys), a new management page
 * (Webhooks), or a "Coming soon" disabled state for tools we'll surface
 * once the underlying capability ships.
 *
 * Admin-only — issuing an API key or wiring a webhook is the kind of
 * security-relevant action we don't want agents triggering.
 */
export default async function IntegrationsLanding() {
  const { user } = await getSession();
  if (!canManageUsers(user.role)) {
    redirect("/settings/account");
  }

  const tiles: Tile[] = [
    {
      href: "/settings/api-keys",
      icon: KeyRound,
      title: "API keys",
      description:
        "Bearer tokens for the /api/external/v1 API. Use these to drive an n8n HTTP Request node, a Zapier Webhooks step, or your own backend.",
      cta: "Manage",
    },
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
      cta: "How it works",
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
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect this workspace to the tools your team already uses. API keys
          let external systems drive the inbox; webhooks let the inbox push
          events back out.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        {tiles.map((t) => (
          <IntegrationTile key={t.title} {...t} />
        ))}
      </div>

      <section id="n8n" className="mt-12 rounded-lg border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Workflow className="size-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">Using with n8n</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              n8n doesn't need a custom node — the built-in HTTP Request node
              works with our /v1 API. Add a credential of type{" "}
              <code className="rounded bg-muted px-1 py-0.5">Header Auth</code>{" "}
              with header name{" "}
              <code className="rounded bg-muted px-1 py-0.5">Authorization</code>{" "}
              and value{" "}
              <code className="rounded bg-muted px-1 py-0.5">Bearer ccp_…</code>
              , then point requests at any of these endpoints:
            </p>
            <ul className="mt-3 grid grid-cols-1 gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              <li>
                <code className="font-mono">POST /api/external/v1/contacts/upsert</code>
              </li>
              <li>
                <code className="font-mono">PATCH /api/external/v1/contacts/:id</code>
              </li>
              <li>
                <code className="font-mono">POST /api/external/v1/contacts/:id/tags</code>
              </li>
              <li>
                <code className="font-mono">
                  POST /api/external/v1/conversations/:id/messages
                </code>
              </li>
              <li>
                <code className="font-mono">GET /api/external/v1/tags</code>
              </li>
              <li>
                <code className="font-mono">GET /api/external/v1/stages</code>
              </li>
            </ul>
            <div className="mt-4 flex flex-wrap gap-3 text-xs">
              <Link
                href="/settings/api-keys"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Create an API key <ArrowRight className="size-3" />
              </Link>
              <Link
                href="/docs/api"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Full endpoint reference <ExternalLink className="size-3" />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

interface Tile {
  href?: string;
  icon: typeof KeyRound;
  title: string;
  description: string;
  cta: string;
  disabled?: boolean;
}

function IntegrationTile({ href, icon: Icon, title, description, cta, disabled }: Tile) {
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
            <ArrowRight className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          )}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        <div className="mt-2 text-[11px] font-medium text-muted-foreground">
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
