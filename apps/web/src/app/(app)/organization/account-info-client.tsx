"use client";

import { useState, useTransition } from "react";
import { Building2, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/layouts/page-header";
import { apiFetch } from "@/lib/api/client-fetch";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { toast } from "@/lib/toast";
import type { OrganizationOverview } from "@/lib/api/queries";

export function AccountInfoClient({ overview }: { overview: OrganizationOverview }) {
  const refresh = useSoftRefresh();
  const [, startTransition] = useTransition();
  const [name, setName] = useState(overview.name);
  const [saving, setSaving] = useState(false);

  const totalMembers = overview.members.length;
  const totalWorkspaces = overview.workspaces.length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Account info"
        description="Your organization — the layer above every workspace."
      />

      <section className="rounded-xl border bg-card p-5">
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground">
            {overview.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <form
              className="flex items-center gap-1.5"
              onSubmit={async (e) => {
                e.preventDefault();
                const next = name.trim();
                if (!next || next === overview.name) return;
                setSaving(true);
                try {
                  const res = await apiFetch("/api/workspaces/organization", {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ name: next }),
                  });
                  if (!res.ok) throw new Error("Couldn't rename the organization");
                  startTransition(() => refresh());
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Couldn't save");
                } finally {
                  setSaving(false);
                }
              }}
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!overview.canManage || saving}
                maxLength={80}
                className="h-9 max-w-sm text-base font-medium"
                aria-label="Organization name"
              />
              {overview.canManage && name.trim() !== overview.name && (
                <Button type="submit" size="sm" className="h-9 px-3 text-2xs" disabled={saving}>
                  {saving ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : "Save"}
                </Button>
              )}
            </form>
            {!overview.canManage && (
              <p className="mt-1 text-3xs text-muted-foreground">
                Only an organization owner or admin can rename it.
              </p>
            )}
          </div>
        </div>

        <dl className="mt-5 grid gap-4 border-t pt-4 sm:grid-cols-2">
          <Stat label="Organization ID" value={<code className="text-2xs">{overview.id}</code>} />
          <Stat
            label="Plan"
            value={
              <span className="flex items-center gap-1.5 capitalize">
                {overview.plan}
                {overview.status !== "active" && (
                  <Badge variant="muted" className="px-1.5 py-0 text-3xs capitalize">
                    {overview.status}
                  </Badge>
                )}
              </span>
            }
          />
          <Stat
            label="Workspaces"
            value={
              <span className="flex items-center gap-1.5">
                <Building2 aria-hidden className="size-3.5 text-muted-foreground" />
                {totalWorkspaces}
              </span>
            }
          />
          <Stat label="People" value={totalMembers} />
        </dl>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-3xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{value}</dd>
    </div>
  );
}
