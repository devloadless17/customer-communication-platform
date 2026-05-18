import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { getSession } from "@/lib/auth/current-user";
import { listOutboundWebhooks } from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";
import { PUBLIC_EVENT_GROUPS } from "@ccp/shared/outbound-webhooks/public-events";

import { OutboundWebhooksManager } from "@/features/settings/components/outbound-webhooks-manager";

export const metadata = { title: "Webhooks" };
export const dynamic = "force-dynamic";

export default async function WebhooksPage() {
  const { user } = await getSession();
  if (!canManageUsers(user.role)) {
    redirect("/settings/account");
  }

  const webhooks = await listOutboundWebhooks();

  return (
    <div>
      <Link
        href="/settings/integrations"
        className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" />
        Back to Integrations
      </Link>
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Webhooks</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Receive HMAC-signed POST deliveries when events happen in this
          workspace. Each delivery carries an{" "}
          <code className="rounded bg-muted px-1 text-xs">X-CCP-Signature</code>{" "}
          header you verify against the secret shown once on creation.
        </p>
      </header>

      <OutboundWebhooksManager
        initialWebhooks={webhooks}
        eventGroups={PUBLIC_EVENT_GROUPS}
      />
    </div>
  );
}
