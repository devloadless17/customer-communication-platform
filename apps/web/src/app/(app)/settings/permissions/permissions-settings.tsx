"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";

import {
  ALL_CAPABILITIES,
  CAPABILITY_LABELS,
  EDITABLE_ROLES,
  type Capability,
  type EditableRole,
  type RolePermissionsConfig,
} from "@ccp/shared/auth/permissions";
import { roleLabel } from "@ccp/shared/auth/permissions";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/layouts/page-header";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

type EditableMatrix = Record<EditableRole, Record<Capability, boolean>>;

/**
 * Admin grid: rows = capabilities, columns = Manager / Agent toggles (plus an
 * always-on Admin column shown for context). Each toggle persists the WHOLE
 * matrix via PATCH /api/team/permissions — the payload is tiny and this is a
 * low-frequency admin screen, so there's no need for per-field diffing.
 */
export function PermissionsSettings() {
  const [matrix, setMatrix] = useState<EditableMatrix | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Latest committed matrix, so a rapid second toggle (before React re-renders)
  // builds on the first instead of a stale snapshot. Kept in sync with state.
  const matrixRef = useRef<EditableMatrix | null>(matrix);
  useEffect(() => {
    matrixRef.current = matrix;
  }, [matrix]);
  // Serializes PATCHes: each waits for the previous so a slower earlier request
  // can't land AFTER a newer one and silently revert a permission (last-toggle
  // must win). Each PATCH sends the FULL matrix, so ordered application is
  // enough — no per-field merge needed.
  const persistChain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/team/permissions");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          permissions: EditableMatrix;
        };
        if (!cancelled) setMatrix(json.permissions);
      } catch {
        if (!cancelled) setLoadError("Couldn't load permissions. Refresh to retry.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runPersist = useCallback(async (next: EditableMatrix) => {
    // Send only the editable roles; the server validates + ignores anything
    // else. Sending the full resolved map (incl. defaulted keys) is fine —
    // it's still a valid sparse override.
    const body: RolePermissionsConfig = {
      manager: next.manager,
      agent: next.agent,
    };
    setSaving(true);
    try {
      const res = await apiFetch("/api/team/permissions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast("Permissions updated");
    } catch {
      toast("Couldn't save — reverted");
      // Re-fetch authoritative state so the UI doesn't drift from the server.
      try {
        const res = await apiFetch("/api/team/permissions");
        if (res.ok) {
          const json = (await res.json()) as { permissions: EditableMatrix };
          setMatrix(json.permissions);
        }
      } catch {
        /* leave optimistic state; next toggle will retry */
      }
    } finally {
      setSaving(false);
    }
  }, []);

  const persist = useCallback(
    (next: EditableMatrix) => {
      // Serialize onto the chain so concurrent rapid toggles apply IN ORDER on
      // the server (`.then(run, run)` keeps the chain alive even if a prior run
      // rejected — runPersist catches internally, so it won't).
      persistChain.current = persistChain.current.then(
        () => runPersist(next),
        () => runPersist(next),
      );
      return persistChain.current;
    },
    [runPersist],
  );

  const toggle = useCallback(
    (role: EditableRole, cap: Capability) => {
      // Compute next OUTSIDE the state updater. Firing the persist() network
      // mutation from inside a setState updater is unsafe — React can invoke
      // updaters more than once (StrictMode / concurrent), double-sending the
      // PATCH. Read the latest committed matrix from the ref so a rapid second
      // toggle builds on the first.
      const prev = matrixRef.current;
      if (!prev) return;
      const next: EditableMatrix = {
        manager: { ...prev.manager },
        agent: { ...prev.agent },
      };
      next[role][cap] = !next[role][cap];
      matrixRef.current = next;
      setMatrix(next);
      void persist(next);
    },
    [persist],
  );

  return (
    <div>
      <PageHeader
        title="Role permissions"
        description="Choose what managers and agents are allowed to do. Admins always have full access. Changes apply to everyone on the team within a few seconds."
        action={
          saving ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Saving…
            </span>
          ) : undefined
        }
        className="mb-6"
      />

      {loadError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {loadError}
        </div>
      ) : !matrix ? (
        <div className="flex items-center gap-2 px-1 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading permissions…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-130 text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-2xs uppercase tracking-wide text-muted-foreground">
                <th className="sticky left-0 z-20 bg-muted px-4 py-2.5 text-left font-medium">
                  Action
                </th>
                <th className="px-4 py-2.5 text-center font-medium">Admin</th>
                {EDITABLE_ROLES.map((r) => (
                  <th key={r} className="px-4 py-2.5 text-center font-medium">
                    {roleLabel(r)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ALL_CAPABILITIES.map((cap) => (
                <tr
                  key={cap}
                  className="border-b border-border last:border-b-0 hover:bg-accent/20"
                >
                  <td className="sticky left-0 z-10 bg-card px-4 py-3 font-medium text-foreground">
                    {CAPABILITY_LABELS[cap]}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-center">
                      <span
                        title="Admins always have full access"
                        className="inline-flex size-6 items-center justify-center rounded-full bg-primary/10 text-primary"
                      >
                        <ShieldCheck className="size-3.5" />
                      </span>
                    </div>
                  </td>
                  {EDITABLE_ROLES.map((role) => (
                    <td key={role} className="px-4 py-3">
                      <div className="flex justify-center">
                        <Switch
                          checked={matrix[role][cap]}
                          aria-label={`${CAPABILITY_LABELS[cap]} for ${roleLabel(role)}`}
                          onCheckedChange={() => toggle(role, cap)}
                        />
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

