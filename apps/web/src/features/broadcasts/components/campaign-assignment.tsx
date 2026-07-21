"use client";

import { useMemo } from "react";

import type {
  BroadcastAssignmentLeftover,
  BroadcastAssignmentMode,
} from "@ccp/shared/assignment/types";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export interface CampaignAssignmentValue {
  mode: BroadcastAssignmentMode;
  userId: string | null;
  policyId: string | null;
  split: Array<{ userId: string; value: number }>;
  leftover: BroadcastAssignmentLeftover;
  trigger: "on_reply" | "on_send";
  overwrite: boolean;
}

export const EMPTY_CAMPAIGN_ASSIGNMENT: CampaignAssignmentValue = {
  mode: "none",
  userId: null,
  policyId: null,
  split: [],
  leftover: "leave_unassigned",
  trigger: "on_reply",
  overwrite: false,
};

/**
 * "Who owns the replies this campaign generates?"
 *
 * Sending 10,000 templates without deciding this means 10,000 replies land in
 * one undifferentiated Unassigned queue at 9am. The four modes cover what teams
 * actually ask for:
 *
 *   One person       — a small campaign with an owner.
 *   Exact counts     — "the first 50 to Ali, the next 10 to Sara". Literal.
 *   Percentage split — proportional across the whole audience.
 *   Assignment policy— reuse the routing already configured in Settings.
 *
 * The draw happens server-side when the recipient list is built, so an exact
 * count is exactly that. WHEN it lands is a separate choice, and the default is
 * ON REPLY: most people never answer a campaign, so assigning all 10,000 up
 * front would bury the team in conversations nobody will respond to — and those
 * conversations are what capacity limits and least-busy routing count, so the
 * whole routing system would be reading noise.
 */
export function CampaignAssignment({
  value,
  onChange,
  members,
  policies,
  audienceSize,
}: {
  value: CampaignAssignmentValue;
  onChange: (v: CampaignAssignmentValue) => void;
  members: Array<{ id: string; name: string }>;
  policies: Array<{ id: string; name: string; isDefault: boolean }>;
  /** Recipient count, so the preview can show real numbers. */
  audienceSize: number;
}) {
  const patch = (p: Partial<CampaignAssignmentValue>) => onChange({ ...value, ...p });

  const isSplit = value.mode === "split_counts" || value.mode === "split_percent";

  // Preview the actual per-member numbers. Mirrors the server's
  // largest-remainder apportionment so the composer can't promise a split the
  // runner won't produce.
  const preview = useMemo(() => {
    if (!isSplit || value.split.length === 0) return null;
    if (value.mode === "split_counts") {
      let remaining = audienceSize;
      const rows = value.split.map((s) => {
        const count = Math.min(s.value, Math.max(0, remaining));
        remaining -= count;
        return { userId: s.userId, count };
      });
      return { rows, leftover: Math.max(0, remaining) };
    }
    const total = value.split.reduce((a, b) => a + b.value, 0);
    if (total <= 0) return null;
    const exact = value.split.map((s) => (audienceSize * s.value) / total);
    const base = exact.map((x) => Math.floor(x));
    let extra = audienceSize - base.reduce((a, b) => a + b, 0);
    const order = exact
      .map((x, i) => ({ i, frac: x - Math.floor(x) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; extra > 0 && k < order.length; k++, extra--) {
      base[order[k]!.i] = base[order[k]!.i]! + 1;
    }
    return {
      rows: value.split.map((s, i) => ({ userId: s.userId, count: base[i]! })),
      leftover: 0,
    };
  }, [isSplit, value.mode, value.split, audienceSize]);

  const nameOf = (userId: string) =>
    members.find((m) => m.id === userId)?.name ?? "Unknown";

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Assign replies to</label>
        <Select
          value={value.mode}
          onChange={(e) => {
            const mode = e.target.value as BroadcastAssignmentMode;
            patch({
              mode,
              // Seed a usable first row so a split mode isn't an empty form.
              split:
                (mode === "split_counts" || mode === "split_percent") &&
                value.split.length === 0 &&
                members[0]
                  ? [{ userId: members[0].id, value: mode === "split_percent" ? 50 : 10 }]
                  : value.split,
              policyId:
                mode === "policy" && !value.policyId
                  ? (policies.find((p) => p.isDefault)?.id ?? policies[0]?.id ?? null)
                  : value.policyId,
            });
          }}
        >
          <option value="none">No one — leave in the Unassigned queue</option>
          <option value="fixed">One person</option>
          <option value="split_counts">Split by exact counts</option>
          <option value="split_percent">Split by percentage</option>
          <option value="policy">Use an assignment policy</option>
        </Select>
      </div>

      {value.mode === "fixed" && (
        <Select
          value={value.userId ?? ""}
          onChange={(e) => patch({ userId: e.target.value || null })}
        >
          <option value="">Choose a teammate…</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      )}

      {value.mode === "policy" && (
        <div className="space-y-1.5">
          <Select
            value={value.policyId ?? ""}
            onChange={(e) => patch({ policyId: e.target.value || null })}
          >
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.isDefault ? " (default)" : ""}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            Spreads the audience across the policy&apos;s members using its shares.
            Presence and open-chat limits don&apos;t apply here — these replies arrive
            over hours, so who happens to be online right now says nothing about
            who should own them.
          </p>
        </div>
      )}

      {isSplit && (
        <div className="space-y-2">
          {value.split.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <Select
                wrapperClassName="flex-1"
                value={row.userId}
                onChange={(e) => {
                  const next = [...value.split];
                  next[index] = { ...row, userId: e.target.value };
                  patch({ split: next });
                }}
              >
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
              <Input
                type="number"
                min={1}
                className="w-24 text-right"
                value={row.value}
                onChange={(e) => {
                  const next = [...value.split];
                  next[index] = { ...row, value: Math.max(1, Number(e.target.value) || 1) };
                  patch({ split: next });
                }}
              />
              <span className="w-16 text-xs text-muted-foreground">
                {value.mode === "split_counts" ? "people" : "share"}
              </span>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-destructive"
                onClick={() =>
                  patch({ split: value.split.filter((_, i) => i !== index) })
                }
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => {
              const used = new Set(value.split.map((s) => s.userId));
              const next = members.find((m) => !used.has(m.id));
              if (next) {
                patch({
                  split: [
                    ...value.split,
                    { userId: next.id, value: value.mode === "split_percent" ? 50 : 10 },
                  ],
                });
              }
            }}
          >
            + Add member
          </button>

          {preview && (
            <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Of {audienceSize.toLocaleString()} recipients:{" "}
              {preview.rows
                .filter((r) => r.count > 0)
                .map((r) => `${nameOf(r.userId)} ${r.count.toLocaleString()}`)
                .join(" · ")}
              {preview.leftover > 0 && (
                <>
                  {" · "}
                  <span className="font-medium">
                    {preview.leftover.toLocaleString()} left over
                  </span>
                </>
              )}
            </div>
          )}

          {value.mode === "split_counts" && (preview?.leftover ?? 0) > 0 && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Leftover recipients</label>
              <Select
                value={value.leftover}
                onChange={(e) =>
                  patch({ leftover: e.target.value as BroadcastAssignmentLeftover })
                }
              >
                <option value="leave_unassigned">Leave in the Unassigned queue</option>
                <option value="policy">Spread using the default assignment policy</option>
              </Select>
            </div>
          )}
        </div>
      )}

      {value.mode !== "none" && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Assign them</label>
          <Select
            value={value.trigger}
            onChange={(e) =>
              patch({ trigger: e.target.value as "on_reply" | "on_send" })
            }
          >
            <option value="on_reply">Only when the customer replies</option>
            <option value="on_send">Straight away, when the message is sent</option>
          </Select>
          <p className="text-xs text-muted-foreground">
            {value.trigger === "on_reply"
              ? "Recommended. Most people never reply to a campaign \u2014 assigning all of them up front buries your team in conversations nobody will answer, and makes everyone look full to the routing limits. The split is still decided now, so the counts stay exact; it just lands on the people who actually engage."
              : "Every recipient gets an owner the moment their message goes out, replied or not. Pick this when someone is expected to follow up on the outreach itself, not just answer replies \u2014 and remember it counts toward their open-conversation limit."}
          </p>
        </div>
      )}

      {value.mode !== "none" && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={value.overwrite}
            onChange={(e) => patch({ overwrite: e.target.checked })}
          />
          <span>
            Reassign conversations that already have an owner
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Off (recommended): a campaign never takes a live conversation away
              from the agent already handling it.
            </span>
          </span>
        </label>
      )}
    </div>
  );
}
