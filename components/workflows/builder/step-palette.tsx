"use client";

import { useState } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";

import { type StepType, STEP_OPTIONS } from "./types";

/**
 * Step picker. Click a step to add it to the canvas — the parent positions
 * the new node and opens the editor drawer for it.
 *
 * Visual model mirrors respond.io's "Add Step" panel: grouped by intent,
 * compact list, search at the top, click-to-add.
 */

const GROUP_LABELS: Record<string, string> = {
  message: "Messaging",
  convo: "Conversation",
  contact: "Contact",
  control: "Control flow",
  external: "External",
};

interface Props {
  onPick: (type: StepType) => void;
}

export function StepPalette({ onPick }: Props) {
  const [q, setQ] = useState("");
  const filtered = STEP_OPTIONS.filter(
    (s) =>
      !q ||
      s.label.toLowerCase().includes(q.toLowerCase()) ||
      s.description.toLowerCase().includes(q.toLowerCase()),
  );
  const grouped = filtered.reduce<Record<string, typeof STEP_OPTIONS>>((acc, s) => {
    (acc[s.group] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search steps…"
          className="h-8 pl-8 text-xs"
        />
      </div>
      <div className="flex flex-col gap-4 overflow-y-auto">
        {Object.entries(grouped).map(([group, options]) => (
          <div key={group}>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {GROUP_LABELS[group] ?? group}
            </div>
            <div className="flex flex-col gap-1">
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => onPick(o.value)}
                  className="rounded-md border border-border bg-card px-2.5 py-2 text-left text-xs transition-colors hover:bg-accent/40"
                >
                  <div className="text-sm font-medium">{o.label}</div>
                  <div className="text-[11px] text-muted-foreground">{o.description}</div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
