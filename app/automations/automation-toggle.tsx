"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Compact on/off switch for an automation row. Posts a PATCH and refreshes
 * the route on success so the server-rendered list reflects the new state.
 * Optimistic — flips the visual immediately and reverts on failure.
 */
export function AutomationToggle({
  id,
  enabled: initial,
}: {
  id: string;
  enabled: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/team/automations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: next }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        router.refresh();
      } catch (err) {
        console.error("[automation-toggle]", err);
        setEnabled(!next); // revert
      }
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? "Disable automation" : "Enable automation"}
      className={
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 " +
        (enabled ? "bg-primary" : "bg-muted")
      }
    >
      <span
        className={
          "inline-block size-4 transform rounded-full bg-background shadow-sm transition-transform " +
          (enabled ? "translate-x-[18px]" : "translate-x-0.5")
        }
      />
    </button>
  );
}
