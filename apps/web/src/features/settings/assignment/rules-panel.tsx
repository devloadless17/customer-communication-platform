"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";

import { LIVE_CHANNELS } from "@ccp/shared/providers/capabilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

import type { MemberRow, PolicyRow, RuleRow } from "./types";

/**
 * Routing rules: which policy handles which conversation.
 *
 * FIRST MATCH WINS, top to bottom — deliberately not a scoring or
 * "most specific" system. An admin reading the list in order can predict the
 * outcome exactly, and a conversation that matches nothing falls through to the
 * default policy. That predictability is worth more than the extra expressive
 * power a weighted matcher would buy.
 *
 * Within one rule every filled-in condition must match (AND); within a
 * condition any listed value matches (OR).
 */
export function RulesPanel({
  rules,
  policies,
  onChanged,
}: {
  rules: RuleRow[];
  policies: PolicyRow[];
  members: MemberRow[];
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const defaultPolicy = policies.find((p) => p.isDefault) ?? policies[0];

  const call = async (path: string, init: RequestInit, message?: string) => {
    setBusy(true);
    try {
      const res = await apiFetch(path, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await onChanged();
      if (message) toast(message);
    } catch {
      toast("That didn't work");
    } finally {
      setBusy(false);
    }
  };

  const createRule = () =>
    call(
      "/api/team/assignment/rules",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "New rule",
          policyId: defaultPolicy?.id,
          enabled: true,
          conditions: {},
        }),
      },
      "Rule added",
    );

  const move = (index: number, delta: number) => {
    const next = [...rules];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    return call("/api/team/assignment/rules/order", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ruleIds: next.map((r) => r.id) }),
    });
  };

  const patchRule = (id: string, body: Record<string, unknown>) =>
    call(`/api/team/assignment/rules/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Checked top to bottom — the first rule that matches decides which policy
        runs. Anything that matches no rule uses{" "}
        <span className="font-medium text-foreground">
          {defaultPolicy?.name ?? "the default policy"}
        </span>
        .
      </p>

      {rules.length === 0 && (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          No rules yet. Every conversation uses{" "}
          {defaultPolicy?.name ?? "the default policy"}.
        </div>
      )}

      {rules.map((rule, index) => (
        <section key={rule.id} className="space-y-3 rounded-lg border border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="w-6 shrink-0 text-xs tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <Input
              className="flex-1"
              defaultValue={rule.name}
              maxLength={80}
              onBlur={(e) => {
                if (e.target.value.trim() && e.target.value !== rule.name) {
                  void patchRule(rule.id, { name: e.target.value.trim() });
                }
              }}
            />
            <Switch
              checked={rule.enabled}
              onCheckedChange={(v) => void patchRule(rule.id, { enabled: v })}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || index === 0}
              onClick={() => void move(index, -1)}
              title="Move up"
            >
              <ArrowUp className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || index === rules.length - 1}
              onClick={() => void move(index, 1)}
              title="Move down"
            >
              <ArrowDown className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void call(
                  `/api/team/assignment/rules/${rule.id}`,
                  { method: "DELETE" },
                  "Rule deleted",
                )
              }
              title="Delete rule"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>

          <div className="grid gap-3 pl-8 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">When the channel is</label>
              <Select
                multiple
                className="h-auto min-h-24"
                value={rule.conditions.channels ?? []}
                onChange={(e) =>
                  void patchRule(rule.id, {
                    conditions: {
                      ...rule.conditions,
                      channels: selectedValues(e.target),
                    },
                  })
                }
              >
                {[...LIVE_CHANNELS].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Nothing selected = any channel.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">
                When the message contains
              </label>
              <Input
                defaultValue={(rule.conditions.keywords ?? []).join(", ")}
                placeholder="refund, cancel, urgent"
                onBlur={(e) =>
                  void patchRule(rule.id, {
                    conditions: {
                      ...rule.conditions,
                      keywords: splitList(e.target.value),
                    },
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated, case-insensitive. Only matches where there is a
                message to read — never on a campaign assignment.
              </p>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-xs font-medium">Then route with</label>
              <Select
                value={rule.policyId}
                onChange={(e) => void patchRule(rule.id, { policyId: e.target.value })}
              >
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </section>
      ))}

      <Button size="sm" variant="outline" onClick={() => void createRule()} disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        Add rule
      </Button>
    </div>
  );
}

function selectedValues(el: HTMLSelectElement): string[] {
  return Array.from(el.selectedOptions).map((o) => o.value);
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
