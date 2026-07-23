"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layouts/page-header";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

import { AutomationPanel } from "./automation-panel";
import { PolicyCard } from "./policy-card";
import { RulesPanel } from "./rules-panel";
import type { AssignmentOverview } from "./types";

// "Teams" is the user-facing name for what the schema calls an
// AssignmentPolicy: a named group of members with a strategy, weights and
// capacity. It IS the routable team — inventing a second entity beside it
// would give one concept two homes that could disagree about who is on it.
const TABS = [
  { key: "policies", label: "Teams" },
  { key: "rules", label: "Routing rules" },
  { key: "automation", label: "When it runs" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/**
 * Assignment routing settings.
 *
 * Three tabs, in the order an admin actually thinks:
 *   Policies      — HOW to pick someone (strategy, weights, limits, who's in)
 *   Routing rules — WHICH policy applies to a given conversation
 *   When it runs  — WHEN routing fires at all (new chat, reopen, AI handoff,
 *                   offline rebalance)
 *
 * The whole page is driven by one GET, and every mutation re-fetches it. This
 * is a low-traffic admin screen where a stale weight is worse than a round
 * trip, so there's no optimistic-state machinery to get wrong — a deliberate
 * contrast with the inbox.
 */
export function AssignmentSettings() {
  const [data, setData] = useState<AssignmentOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("policies");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/workspace/assignment");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as AssignmentOverview);
      setLoadError(null);
    } catch {
      setLoadError("Couldn't load assignment settings. Refresh to retry.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const createPolicy = useCallback(async () => {
    setCreating(true);
    try {
      const res = await apiFetch("/api/workspace/assignment/policies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "New policy" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
      toast("Policy created");
    } catch {
      toast("Couldn't create the policy");
    } finally {
      setCreating(false);
    }
  }, [load]);

  if (loadError) {
    return (
      <div className="space-y-6">
        <PageHeader title="Assignment" />
        <p className="text-sm text-destructive">{loadError}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <PageHeader title="Assignment" />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Teams & routing"
        description="Group people into teams, decide who takes each conversation, and when that happens automatically."
        action={
          tab === "policies" ? (
            <Button size="sm" onClick={() => void createPolicy()} disabled={creating}>
              {creating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              New team
            </Button>
          ) : undefined
        }
      />

      {/* Hand-rolled tabs, matching the AI Assistant settings page — the design
          system has no Tabs primitive and one screen doesn't justify adding it. */}
      <div
        role="tablist"
        aria-label="Assignment settings sections"
        className="flex gap-1 border-b border-border"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors " +
              (tab === t.key
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "policies" && (
        <div className="space-y-4">
          {data.policies.map((policy) => (
            <PolicyCard
              key={policy.id}
              policy={policy}
              members={data.members}
              policyCount={data.policies.length}
              onChanged={load}
            />
          ))}
        </div>
      )}

      {tab === "rules" && (
        <RulesPanel
          rules={data.rules}
          policies={data.policies}
          members={data.members}
          onChanged={load}
        />
      )}

      {tab === "automation" && (
        <AutomationPanel settings={data.settings} policies={data.policies} onChanged={load} />
      )}
    </div>
  );
}
