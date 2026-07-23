"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Star, Trash2 } from "lucide-react";

import {
  ASSIGNMENT_ELIGIBILITIES,
  ASSIGNMENT_OVERFLOWS,
  ASSIGNMENT_STRATEGIES,
  type AssignmentEligibility,
  type AssignmentOverflow,
  type AssignmentStrategy,
} from "@ccp/shared/assignment/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

import { PolicyPreview } from "./policy-preview";
import {
  ELIGIBILITY_HINTS,
  ELIGIBILITY_LABELS,
  OVERFLOW_LABELS,
  STRATEGY_HINTS,
  STRATEGY_LABELS,
  type MemberRow,
  type PolicyRow,
} from "./types";

/**
 * One policy, collapsed to a summary line until opened.
 *
 * Editing is explicit (a draft + a Save button) rather than per-field
 * auto-save, because a policy is a coherent whole: switching to `weighted` and
 * then setting the weights are two halves of one intent, and auto-saving the
 * first half would re-route live traffic through a half-configured rule.
 *
 * The save carries `expectedVersion`; a 409 means a co-admin saved first, and
 * we say so instead of silently overwriting their weights.
 */
export function PolicyCard({
  policy,
  members,
  policyCount,
  onChanged,
}: {
  policy: PolicyRow;
  members: MemberRow[];
  policyCount: number;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PolicyRow>(policy);
  const [saving, setSaving] = useState(false);

  // Per-member override rows, merged with the full roster so every teammate has
  // a line to edit even when the policy has no row for them yet.
  const memberDraft = useMemo(() => {
    const byUser = new Map(draft.members.map((m) => [m.userId, m]));
    return members.map((m) => ({
      user: m,
      weight: byUser.get(m.id)?.weight ?? 1,
      maxOpen: byUser.get(m.id)?.maxOpen ?? null,
      enabled: byUser.get(m.id)?.enabled ?? true,
      hasRow: byUser.has(m.id),
    }));
  }, [draft.members, members]);

  const patchDraft = (patch: Partial<PolicyRow>) =>
    setDraft((d) => ({ ...d, ...patch }));

  const patchMember = (
    userId: string,
    patch: { weight?: number; maxOpen?: number | null; enabled?: boolean },
  ) => {
    setDraft((d) => {
      const existing = d.members.find((m) => m.userId === userId);
      const base = existing ?? {
        userId,
        weight: 1,
        maxOpen: null,
        enabled: true,
        served: 0,
      };
      const next = { ...base, ...patch };
      return {
        ...d,
        members: existing
          ? d.members.map((m) => (m.userId === userId ? next : m))
          : [...d.members, next],
      };
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await apiFetch(`/api/workspace/assignment/policies/${policy.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          description: draft.description,
          strategy: draft.strategy,
          eligibility: draft.eligibility,
          eligibleRoles: draft.eligibleRoles,
          includeAllMembers: draft.includeAllMembers,
          defaultMaxOpen: draft.defaultMaxOpen,
          overflow: draft.overflow,
          fallbackUserId: draft.fallbackUserId,
          fixedUserId: draft.fixedUserId,
          preferPreviousAgent: draft.preferPreviousAgent,
          previousAgentWindowDays: draft.previousAgentWindowDays,
          // Send only rows that actually differ from the defaults, so a policy
          // whose members are all untouched stays clean in the database.
          members: memberDraft
            .filter((m) => m.hasRow || m.weight !== 1 || m.maxOpen != null || !m.enabled)
            .map((m) => ({
              userId: m.user.id,
              weight: m.weight,
              maxOpen: m.maxOpen,
              enabled: m.enabled,
            })),
          expectedVersion: draft.version,
        }),
      });
      if (res.status === 409) {
        toast("Someone else changed this policy — reloading their version");
        await onChanged();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await onChanged();
      toast("Policy saved");
    } catch {
      toast("Couldn't save the policy");
    } finally {
      setSaving(false);
    }
  };

  const act = async (path: string, method: string, successMessage: string) => {
    try {
      const res = await apiFetch(path, { method });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await onChanged();
      toast(successMessage);
    } catch {
      toast("That didn't work");
    }
  };

  const showWeights = draft.strategy === "weighted";
  const showFixed = draft.strategy === "fixed";
  const showCapacity = draft.strategy !== "fixed" && draft.strategy !== "manual";

  return (
    <section className="rounded-lg border border-border">
      <header className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm font-medium">{policy.name}</span>
          {policy.isDefault && <Badge variant="secondary">Default</Badge>}
          <span className="truncate text-xs text-muted-foreground">
            {STRATEGY_LABELS[policy.strategy]}
          </span>
        </button>
        {!policy.isDefault && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void act(
                  `/api/workspace/assignment/policies/${policy.id}/default`,
                  "POST",
                  "Default policy updated",
                )
              }
              title="Make this the fallback policy"
            >
              <Star className="size-4" />
            </Button>
            {policyCount > 1 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void act(
                    `/api/workspace/assignment/policies/${policy.id}`,
                    "DELETE",
                    "Policy archived",
                  )
                }
                title="Archive this policy"
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </>
        )}
      </header>

      {open && (
        <div className="space-y-5 border-t border-border px-4 py-4">
          <Field label="Name">
            <Input
              value={draft.name}
              maxLength={80}
              onChange={(e) => patchDraft({ name: e.target.value })}
            />
          </Field>

          <Field label="How to pick someone" hint={STRATEGY_HINTS[draft.strategy]}>
            <Select
              value={draft.strategy}
              onChange={(e) =>
                patchDraft({ strategy: e.target.value as AssignmentStrategy })
              }
            >
              {ASSIGNMENT_STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {STRATEGY_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>

          {showFixed && (
            <Field label="Assign everything to">
              <Select
                value={draft.fixedUserId ?? ""}
                onChange={(e) => patchDraft({ fixedUserId: e.target.value || null })}
              >
                <option value="">Choose a teammate…</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {draft.strategy !== "manual" && (
            <Field
              label="Who is eligible"
              hint={ELIGIBILITY_HINTS[draft.eligibility]}
            >
              <Select
                value={draft.eligibility}
                onChange={(e) =>
                  patchDraft({ eligibility: e.target.value as AssignmentEligibility })
                }
              >
                {ASSIGNMENT_ELIGIBILITIES.map((s) => (
                  <option key={s} value={s}>
                    {ELIGIBILITY_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {draft.strategy !== "manual" && draft.strategy !== "fixed" && (
            <label className="flex items-start gap-3">
              <Switch
                checked={draft.preferPreviousAgent}
                onCheckedChange={(v) => patchDraft({ preferPreviousAgent: v })}
              />
              <span className="text-sm">
                Send returning customers back to the same person
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  If someone already talked to this customer in the last{" "}
                  {draft.previousAgentWindowDays} days, they get the conversation
                  again — but only if they&apos;re available and under their limit.
                  Otherwise it routes normally, so nobody waits for an agent who
                  has gone home. Works across channels: WhatsApp last week and
                  Instagram today is the same relationship.
                </span>
              </span>
            </label>
          )}

          {draft.preferPreviousAgent &&
            draft.strategy !== "manual" &&
            draft.strategy !== "fixed" && (
              <Field
                label="Remember the relationship for"
                hint="After this, the customer is routed as if they were new."
              >
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={365}
                    className="w-24"
                    value={draft.previousAgentWindowDays}
                    onChange={(e) =>
                      patchDraft({
                        previousAgentWindowDays: Math.max(1, Number(e.target.value) || 1),
                      })
                    }
                  />
                  <span className="text-sm text-muted-foreground">days</span>
                </div>
              </Field>
            )}

          {showCapacity && (
            <>
              <Field
                label="Default limit per person"
                hint="Maximum open conversations anyone in this policy carries at once. Leave empty for no limit; set it per person below to override."
              >
                <Input
                  type="number"
                  min={0}
                  max={10000}
                  placeholder="No limit"
                  value={draft.defaultMaxOpen ?? ""}
                  onChange={(e) =>
                    patchDraft({
                      defaultMaxOpen: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </Field>

              <Field
                label="When everyone is at their limit"
                hint="Nobody eligible, or everybody full. Leaving it unassigned keeps the conversation visible in the triage queue — the safest default."
              >
                <Select
                  value={draft.overflow}
                  onChange={(e) =>
                    patchDraft({ overflow: e.target.value as AssignmentOverflow })
                  }
                >
                  {ASSIGNMENT_OVERFLOWS.map((s) => (
                    <option key={s} value={s}>
                      {OVERFLOW_LABELS[s]}
                    </option>
                  ))}
                </Select>
              </Field>

              {draft.overflow === "fallback_user" && (
                <Field label="Fallback person">
                  <Select
                    value={draft.fallbackUserId ?? ""}
                    onChange={(e) =>
                      patchDraft({ fallbackUserId: e.target.value || null })
                    }
                  >
                    <option value="">Choose a teammate…</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}

              <label className="flex items-start gap-3">
                <Switch
                  checked={!draft.includeAllMembers}
                  onCheckedChange={(v) => patchDraft({ includeAllMembers: !v })}
                />
                <span className="text-sm">
                  Only specific people
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Off: everyone on the team is eligible and the rows below just
                    tune them. On: only the people you switch on take part.
                  </span>
                </span>
              </label>

              <div className="rounded-md border border-border">
                <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 border-b border-border px-3 py-2 text-xs text-muted-foreground">
                  <span>Member</span>
                  <span className="w-14 text-right">Open now</span>
                  {showWeights && <span className="w-16 text-right">Share</span>}
                  <span className="w-16 text-right">Limit</span>
                  <span className="w-10 text-right">In</span>
                </div>
                {memberDraft.map((m) => (
                  <div
                    key={m.user.id}
                    className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm">{m.user.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {m.user.role}
                      </div>
                    </div>
                    <span className="w-14 text-right text-sm tabular-nums text-muted-foreground">
                      {m.user.openCount}
                    </span>
                    {showWeights && (
                      <Input
                        type="number"
                        min={0}
                        max={10000}
                        className="w-16 text-right"
                        value={m.weight}
                        onChange={(e) =>
                          patchMember(m.user.id, { weight: Number(e.target.value) || 0 })
                        }
                      />
                    )}
                    <Input
                      type="number"
                      min={0}
                      max={10000}
                      className="w-16 text-right"
                      placeholder="—"
                      value={m.maxOpen ?? ""}
                      onChange={(e) =>
                        patchMember(m.user.id, {
                          maxOpen: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    />
                    <div className="flex w-10 justify-end">
                      <Switch
                        checked={m.enabled}
                        onCheckedChange={(v) => patchMember(m.user.id, { enabled: v })}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {showWeights && <WeightSummary members={memberDraft} />}
            </>
          )}

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save policy
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDraft(policy)}
              disabled={saving}
            >
              Reset
            </Button>
          </div>

          <PolicyPreview policyId={policy.id} />
        </div>
      )}
    </section>
  );
}

/**
 * Turns raw weights into the sentence the admin is actually trying to write:
 * "out of every 100 conversations, Ali gets 50". Weights are relative, so a
 * 50/20 split and a 5/2 split are identical — showing the normalized result
 * is what makes that obvious instead of surprising.
 */
function WeightSummary({
  members,
}: {
  members: { user: MemberRow; weight: number; enabled: boolean }[];
}) {
  const active = members.filter((m) => m.enabled && m.weight > 0);
  const total = active.reduce((s, m) => s + m.weight, 0);
  if (total === 0) {
    return (
      <p className="text-xs text-destructive">
        Every share is zero — this policy can&apos;t assign anyone. Give at least one
        person a share above 0.
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Out of every 100 conversations:{" "}
      {active
        .map((m) => `${m.user.name} ${Math.round((m.weight / total) * 100)}`)
        .join(" · ")}
    </p>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
