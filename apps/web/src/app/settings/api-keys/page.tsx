import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { getSession } from "@/lib/auth/current-user";
import { listApiKeys } from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";

import { ApiKeysManager } from "@/features/settings/components/api-keys-manager";

export const metadata = { title: "API keys" };
export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const { user } = await getSession();
  if (!canManageUsers(user.role)) {
    redirect("/settings/account");
  }

  const keys = await listApiKeys();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <Link
        href="/settings/integrations"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" />
        Back to Integrations
      </Link>
      <header>
        <h1 className="text-xl font-semibold">API keys</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Bearer tokens for the <code className="rounded bg-muted px-1 text-xs">/api/external/v1</code>{" "}
          API — used by n8n, Zapier, your own backend. Each key is shown in
          plaintext exactly once; lost keys must be rotated.
        </p>
      </header>

      <ApiKeysManager initialKeys={keys} />
    </div>
  );
}
