import { redirect } from "next/navigation";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { canManageUsers } from "@/lib/permissions";

import { ApiKeysManager } from "@/components/settings/api-keys-manager";

export const metadata = { title: "API keys" };
export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  const { user, teamId } = await getSession();
  if (!canManageUsers(user.role)) {
    redirect("/settings/account");
  }

  const rows = await db.teamApiKey.findMany({
    where: { teamId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold">API keys</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Bearer tokens for the <code className="rounded bg-muted px-1 text-xs">/api/external/v1</code>{" "}
          API — used by n8n, Zapier, your own backend. Each key is shown in
          plaintext exactly once; lost keys must be rotated.
        </p>
      </header>

      <ApiKeysManager
        initialKeys={rows.map((k) => ({
          id: k.id,
          name: k.name,
          tokenPrefix: k.tokenPrefix,
          createdAt: k.createdAt.toISOString(),
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          revokedAt: k.revokedAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}
