"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";

import { LIVE_CHANNELS } from "@ccp/shared/providers/capabilities";
import type { Channel } from "@ccp/shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";
import { useChannelAccounts } from "@/features/channels/contexts/channel-accounts-context";

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
  // A COUNT, not a boolean. Rule edits no longer disable anything (see
  // `pending`), so a queued edit's call can overlap a move/delete/create call.
  // With one boolean, whichever finished FIRST cleared it and re-enabled
  // Move/Delete over a rule list the other call's refresh was about to
  // replace — a second move built on that stale list silently undid the first.
  const [busyCount, setBusyCount] = useState(0);
  const busy = busyCount > 0;
  /**
   * The rule edit being saved right now, shown until the re-fetch answers.
   *
   * Same defect as AutomationPanel's `pending` (read that note): every control
   * here is bound to the SERVER's copy of the rule, so React snapped it back to
   * the old value for the whole PATCH + re-fetch round trip, then it flipped by
   * itself. Worse here than there, because rule PATCHes carry no version: the
   * multi-selects build the next `conditions` from the rule on screen, so a
   * second ⌘-click inside the window was built on the snapped-back selection
   * and SUCCEEDED — silently dropping the first pick. The controls are disabled
   * while a save runs, and whatever the server answers replaces this.
   */
  // Keyed by rule: every edit not yet confirmed by the server, per rule, so a
  // multi-select building its next `conditions` from `shown(rule)` builds on
  // the LATEST intended state — including a change still waiting to be sent.
  // The EDIT controls below are deliberately NOT disabled while a save runs
  // (move / delete / add still are). They were, and that is what actually ate
  // the second change: a mousedown on the switch blurs the name box, the
  // rename's save flips `busy`, React re-renders the switch disabled, and the
  // click then lands on a disabled control and fires nothing — nothing reached
  // the queue to be saved. Disabling was a stand-in for "don't build on a stale
  // view"; `pending` + the queue now provide exactly that.
  const [pending, setPending] = useState<Record<string, Partial<RuleRow>>>({});
  const inFlight = useRef(false);
  /** Rule edits that arrived while a save was running — merged per rule, sent next. */
  const queued = useRef(new Map<string, Partial<RuleRow>>());
  const shown = (rule: RuleRow): RuleRow =>
    pending[rule.id] ? { ...rule, ...pending[rule.id] } : rule;
  const defaultPolicy = policies.find((p) => p.isDefault) ?? policies[0];

  // Accounts worth offering as a routing condition: only on channels that
  // actually hold MORE THAN ONE. A single-number workspace has nothing to
  // disambiguate, so the control is hidden rather than shown-and-useless —
  // the same rule the inbox chip follows.
  const { all: allAccounts } = useChannelAccounts();
  const multiAccountOptions = useMemo(() => {
    const perChannel = new Map<string, number>();
    for (const a of allAccounts) {
      if (a.isActive) perChannel.set(a.channel, (perChannel.get(a.channel) ?? 0) + 1);
    }
    return allAccounts.filter((a) => a.isActive && (perChannel.get(a.channel) ?? 0) > 1);
  }, [allAccounts]);

  const call = async (path: string, init: RequestInit, message?: string) => {
    setBusyCount((n) => n + 1);
    try {
      const res = await apiFetch(path, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await onChanged();
      if (message) toast(message);
    } catch {
      toast("That didn't work");
    } finally {
      setBusyCount((n) => n - 1);
    }
  };

  const createRule = () =>
    call(
      "/api/workspace/assignment/rules",
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
    return call("/api/workspace/assignment/rules/order", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ruleIds: next.map((r) => r.id) }),
    });
  };

  const patchRule = async (id: string, body: Partial<RuleRow>) => {
    // One save at a time, and NOTHING DROPPED — the same fix as
    // AutomationPanel's `patch` (read that note). The name and keyword inputs
    // are uncontrolled and save on blur, so renaming a rule and then clicking
    // its switch fires two saves in one gesture; the second used to be
    // discarded silently, and in the other order the box went on showing a
    // name the server never received. Now it is queued, merged per rule, and
    // sent in order. Rule PATCHes carry no version, so there is no stale-
    // version hazard here — ordering is the whole requirement.
    queued.current.set(id, { ...queued.current.get(id), ...body });
    setPending((p) => ({ ...p, [id]: { ...p[id], ...body } }));
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      for (;;) {
        const first = queued.current.entries().next();
        if (first.done) break;
        const [nextId, nextBody] = first.value;
        queued.current.delete(nextId);
        await call(`/api/workspace/assignment/rules/${nextId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(nextBody),
        });
      }
    } finally {
      inFlight.current = false;
      setPending({});
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Checked top to bottom — the first rule that matches decides which policy
        runs. Anything that matches no rule uses{" "}
        <span className="font-medium text-foreground">
          {defaultPolicy?.name ?? "the default team"}
        </span>
        .
      </p>

      {rules.length === 0 && (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          No rules yet. Every conversation uses{" "}
          {defaultPolicy?.name ?? "the default team"}.
        </div>
      )}

      {rules.map((serverRule, index) => {
        const rule = shown(serverRule);
        return (
        <section key={rule.id} className="space-y-3 rounded-lg border border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="w-6 shrink-0 text-xs tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <Input
              className="flex-1"
              defaultValue={serverRule.name}
              maxLength={80}
              onBlur={(e) => {
                // Against the overlay, not the server copy: renaming A→B and
                // back to A before B's refresh lands is a real change.
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
              disabled={busy}
              onClick={() =>
                void call(
                  `/api/workspace/assignment/rules/${rule.id}`,
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
                      // Options are rendered from LIVE_CHANNELS, so every
                      // selected value is a Channel by construction.
                      channels: selectedValues(e.target) as Channel[],
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

            {/* Which of our NUMBERS / Pages, not just which medium. Hidden
                entirely unless some channel actually holds more than one
                account — on a single-number workspace there is nothing to
                disambiguate and the control would be pure noise. */}
            {multiAccountOptions.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium">When the account is</label>
                <Select
                  multiple
                  className="h-auto min-h-24"
                  value={rule.conditions.channelAccountIds ?? []}
                  onChange={(e) =>
                    void patchRule(rule.id, {
                      conditions: {
                        ...rule.conditions,
                        channelAccountIds: selectedValues(e.target),
                      },
                    })
                  }
                >
                  {multiAccountOptions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-muted-foreground">
                  Nothing selected = any account. Narrower than the channel — pick
                  this to route one number&apos;s chats to its own team.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium">
                When the message contains
              </label>
              <Input
                defaultValue={(serverRule.conditions.keywords ?? []).join(", ")}
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
        );
      })}

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
