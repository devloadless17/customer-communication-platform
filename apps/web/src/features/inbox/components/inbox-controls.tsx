/**
 * Inbox filter types. The UI for these presets + stage rows lives in
 * `components/layouts/inbox-sub-sidebar.tsx`; this file is types-only so the
 * shape stays colocated with the inbox feature.
 */

export type PresetFilterId =
  | "active"
  | "all"
  | "mine"
  | "unassigned"
  | "closed"
  // Threads carrying at least one UNRESOLVED message triage flag. Unlike the
  // other working presets this deliberately includes CLOSED threads — an
  // unresolved complaint on a closed conversation is exactly the thing that
  // must not fall off the radar.
  | "flagged";

/**
 * Active inbox filter. Presets and stage filters are mutually exclusive —
 * selecting one clears the other. The discriminated shape lets the
 * conversation list switch on `kind` instead of parsing magic strings, and
 * lets the header render the stage's real name.
 */
export type Filter =
  | { kind: "preset"; id: PresetFilterId }
  | { kind: "stage"; stageId: string }
  // A saved inbox view. Only the id travels — the server owns the filter
  // document, so the client can never widen a view beyond what was saved, and
  // a personal view can't be read by passing someone else's id.
  | { kind: "view"; viewId: string }
  // The "Calls" view — a team-wide call-history list rendered inside the inbox
  // content area (not a separate route), so it behaves like the other filters.
  | { kind: "calls" };
