"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Settings2,
} from "lucide-react";
import Link from "next/link";

import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { cn } from "@ccp/shared/utils";
import type { ContactStage } from "@ccp/shared/types";

/**
 * Pill that shows the contact's current stage and opens a popover with the
 * full stage catalog to switch.
 *
 * Three sizes:
 *   - `xs` / `sm` — compact pill for table rows.
 *   - `md` (default) — fuller chrome for the contact panel.
 *
 * The "Manage stages…" footer link is gated on `canManage`. Agents see the
 * picker but not the management link (they can move contacts; only managers
 * edit the catalog itself).
 */
export function ContactStagePicker({
  stages,
  currentStageId,
  onChange,
  canManage,
  size = "md",
  label,
}: {
  stages: ContactStage[];
  currentStageId: string | null | undefined;
  /** Returns a promise that resolves on save; the picker shows a spinner
   *  while it's pending and closes itself once it resolves. */
  onChange: (stageId: string) => Promise<void>;
  canManage: boolean;
  size?: "xs" | "sm" | "md";
  /** Optional prefix label (e.g. "Stage" in the panel; absent in the row). */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!boxRef.current) return;
      if (!boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const current = stages.find((s) => s.id === currentStageId) ?? null;
  // The `md` picker lives in the contact panel/drawer where the trigger sits
  // at the panel's left edge — anchor the popover left so it opens *into* the
  // panel. Compact pickers (`xs` row right-cluster, `sm` inbox header) sit at
  // the right, so they anchor right to stay on-screen.
  const popoverAlign = size === "md" ? "left-0" : "right-0";
  const triggerHeight = size === "xs" ? "h-6" : size === "sm" ? "h-7" : "h-8";
  const dotSize = size === "xs" ? "size-2" : "size-2.5";
  const textSize = size === "xs" ? "text-2xs" : "text-xs";

  async function pick(stageId: string) {
    if (stageId === currentStageId || saving) return;
    setSaving(true);
    try {
      await onChange(stageId);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={boxRef} className="relative inline-flex max-w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={stages.length === 0}
        className={cn(
          "inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border px-2",
          triggerHeight,
          textSize,
          current
            ? "border-border bg-card text-foreground hover:bg-accent"
            : "border-dashed border-border text-muted-foreground hover:bg-accent",
          stages.length === 0 && "cursor-not-allowed opacity-60",
        )}
        title={
          stages.length === 0
            ? "No stages yet — create one in Settings → Stages."
            : current
              ? `Stage: ${current.name}`
              : "Pick a stage"
        }
      >
        {current ? (
          <>
            <span
              className={cn(
                "inline-block shrink-0 rounded-full",
                dotSize,
                tagColorClasses(current.color).solid,
              )}
            />
            {label && <span className="text-muted-foreground">{label}:</span>}
            <span className="truncate font-medium">{current.name}</span>
          </>
        ) : (
          <>
            {label && <span>{label}:</span>}
            <span>Set stage…</span>
          </>
        )}
        {saving ? (
          <Loader2 className="size-3 shrink-0 animate-spin opacity-70" />
        ) : (
          <ChevronDown className="size-3 shrink-0 opacity-50" />
        )}
      </button>

      {open && (
        <div className={cn("absolute top-full z-30 mt-1 w-60 overflow-hidden rounded-xl border border-border bg-popover shadow-xl", popoverAlign)}>
          <div className="border-b border-border px-3 py-2 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
            Customer stage
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {stages.length === 0 && (
              <li className="px-3 py-4 text-center text-[12px] text-muted-foreground">
                No stages yet.
              </li>
            )}
            {stages.map((s) => {
              const isCurrent = s.id === currentStageId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => void pick(s.id)}
                    disabled={isCurrent || saving}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent/60",
                      isCurrent && "bg-accent/40",
                      saving && "cursor-wait opacity-60",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-block size-2.5 shrink-0 rounded-full",
                        tagColorClasses(s.color).solid,
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    {s.isDefault && (
                      <span className="text-3xs text-muted-foreground">default</span>
                    )}
                    {isCurrent && <Check className="size-3.5 text-primary" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {canManage && (
            <Link
              href="/settings/stages"
              className="flex items-center gap-2 border-t border-border bg-muted/30 px-3 py-2 text-2xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            >
              <Settings2 className="size-3" />
              Manage stages…
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Inbox-header stage control. Three pieces side-by-side:
 *
 *    [◀]  [● Stage Name ▾]  [▶]
 *
 * Arrows step the contact one slot earlier / later in the catalog (sorted
 * by `position`). The middle pill is the existing `ContactStagePicker` —
 * clicking it opens the dropdown so an agent can also JUMP to a specific
 * stage rather than stepping one at a time. End-of-list arrows disable.
 *
 * One save path: every change (arrow click or picker pick) calls the same
 * `onChange(stageId)` so the parent only has to wire one optimistic-PATCH
 * handler.
 */
export function ContactStageStepper({
  stages,
  currentStageId,
  onChange,
  canManage,
}: {
  stages: ContactStage[];
  currentStageId: string | null | undefined;
  onChange: (stageId: string) => Promise<void>;
  canManage: boolean;
}) {
  const sorted = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );
  const [stepping, setStepping] = useState<"prev" | "next" | null>(null);

  const currentIdx = currentStageId
    ? sorted.findIndex((s) => s.id === currentStageId)
    : -1;

  // When the contact has no stage at all (orphaned after a delete), the
  // "previous" arrow drops the user into the first stage as a sensible
  // landing — better than a no-op arrow.
  const prevStage = currentIdx > 0 ? sorted[currentIdx - 1] : currentIdx === -1 && sorted[0] ? sorted[0] : null;
  const nextStage =
    currentIdx >= 0 && currentIdx < sorted.length - 1
      ? sorted[currentIdx + 1]
      : currentIdx === -1 && sorted[0]
        ? sorted[0]
        : null;

  async function step(direction: "prev" | "next") {
    const target = direction === "prev" ? prevStage : nextStage;
    if (!target || stepping) return;
    setStepping(direction);
    try {
      await onChange(target.id);
    } finally {
      setStepping(null);
    }
  }

  return (
    <div className="inline-flex items-center gap-1">
      <StepArrow
        direction="prev"
        disabled={!prevStage || stepping !== null}
        busy={stepping === "prev"}
        targetName={prevStage?.name}
        onClick={() => void step("prev")}
      />
      <ContactStagePicker
        stages={stages}
        currentStageId={currentStageId}
        onChange={onChange}
        canManage={canManage}
        size="sm"
      />
      <StepArrow
        direction="next"
        disabled={!nextStage || stepping !== null}
        busy={stepping === "next"}
        targetName={nextStage?.name}
        onClick={() => void step("next")}
      />
    </div>
  );
}

function StepArrow({
  direction,
  disabled,
  busy,
  targetName,
  onClick,
}: {
  direction: "prev" | "next";
  disabled: boolean;
  busy: boolean;
  /** Used in the title tooltip so hovering shows where the click will land. */
  targetName: string | undefined;
  onClick: () => void;
}) {
  const Icon =
    busy ? Loader2 : direction === "prev" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={
        direction === "prev"
          ? targetName
            ? `Move to ${targetName}`
            : "Previous stage"
          : targetName
            ? `Move to ${targetName}`
            : "Next stage"
      }
      title={
        targetName
          ? `${direction === "prev" ? "Back" : "Advance"} to ${targetName}`
          : direction === "prev"
            ? "Already in the first stage"
            : "Already in the last stage"
      }
      className={cn(
        "inline-flex size-7 cursor-pointer items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-card disabled:hover:text-muted-foreground",
      )}
    >
      <Icon className={cn("size-3.5", busy && "animate-spin")} />
    </button>
  );
}
